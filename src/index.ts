import { Hono } from "hono";
import { Bot, Context, InlineKeyboard, session, StorageAdapter } from "grammy";
import { processAi, processAiStream, transcribeAudio, fileToBase64, loadUserMemories, clearUserMemories, isTextDocument, isPdfDocument, extractPdfText, renderLatex, renderMermaid, MODELS, runScheduledJob, computeJobNextRun, type JobRow, fetchUrlContent, getWeather, getYoutubeTranscript, listJobs, buildSchedule, createJob, cancelJob, detectEmotion, kgQuery, kgForget, loadKnowledge } from "./ai";
import { escapeHtml, stripHtml, safeHtmlPartial, mdToTelegramHtml } from "./markdown";

// In-memory dedup for webhook update IDs — fast path only. The authoritative
// dedup is the D1 `dedup` table (INSERT OR IGNORE), because the in-memory Map
// lives per-isolate and leaked duplicates when Cloudflare routed retries to a
// different isolate.
const recentUpdates = new Map<number, number>();
const DEDUP_TTL_MS = 10_000;

// Per-chat serialization: consecutive updates from one chat run one at a time
// (in-isolate) so the D1 session read-modify-write in grammY's session plugin
// never races. Webhook processing is decoupled via waitUntil, so without this
// queue a burst of messages would overwrite each other's history writes.
const chatQueues = new Map<string, Promise<void>>();
function serializeChat(chatKey: string, task: () => Promise<void>): Promise<void> {
  const prev = chatQueues.get(chatKey) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(task);
  chatQueues.set(chatKey, run);
  run
    .finally(() => {
      if (chatQueues.get(chatKey) === run) chatQueues.delete(chatKey);
    })
    .catch(() => {});
  return run;
}

function extractChatKey(update: any): string {
  const msg = update?.message || update?.edited_message || update?.channel_post || update?.callback_query?.message;
  if (msg?.chat?.id) return String(msg.chat.id);
  if (update?.inline_query?.from?.id) return String(update.inline_query.from.id);
  return "global";
}

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID?: string;
  GROQ_API_KEY: string;
  GEMINI_API_KEY?: string;
  GITHUB_PAT: string;
  GITHUB_REPO: string;
  ADMIN_PASSWORD?: string;
  TAVILY_API_KEY?: string;
  TMDB_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_USER_AGENT?: string;
  IVY_DB: D1Database;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_RELAY_SECRET?: string;
  /** Owner-provided persona override (set via `wrangler secret put IVY_PERSONA`). */
  IVY_PERSONA?: string;
}

interface SessionData {
  history: Array<{ role: string; content?: string }>;
  model: string;
  lastUserMessage?: string;
  activeUrl?: string;
  activeUrlData?: {
    ok: boolean;
    status?: number;
    title?: string;
    url: string;
    text?: string;
    hash?: string;
    fetchedAt: number;
    chars?: number;
    error?: string;
  } | null;
  /** User-configurable personality traits (tone/language/behavior). */
  personality?: { formality?: string; humor?: string; empathy?: string };
}

type MyContext = Context & { session: SessionData };

const MAX_HISTORY = 10;

function getSystemPrompt(opts: {
  memories?: string;
  hasMovies?: boolean;
  activePage?: SessionData["activeUrlData"];
  personality?: SessionData["personality"];
  knowledge?: string;
  emotion?: { emotion: string; intensity: number; cues?: string[] };
  persona?: string;
}): string {
  const { memories, hasMovies, activePage, personality, knowledge, emotion, persona } = opts;
  let prompt =
    "You are Ivy. You help with planning, reminders, and light research. " +
    "You're helpful and friendly, like a good friend who happens to be very knowledgeable. " +
    "Use memory_save to remember things the user tells you about themselves and memory_recall to retrieve them. " +
    "You have persistent memory across conversations — anything saved via memory_save is loaded automatically next time we talk. " +
    `Current UTC time is: ${new Date().toISOString()}`;

  if (persona) {
    prompt +=
      `\n\n👑 <Persona override> (your core identity — always follow this, it takes precedence over the description above):\n${persona}`;
  }

  if (personality && (personality.formality || personality.humor || personality.empathy)) {
    const f = personality.formality || "balanced";
    const h = personality.humor || "subtle";
    const e = personality.empathy || "warm";
    prompt +=
      `\n\n🎭 <Personality settings> (user-configured — follow them):\n` +
      `- Formality: ${f} (casual = relaxed chat, balanced = natural, professional = polished)\n` +
      `- Humor: ${h} (off/subtle/witty/playful — match the requested level)\n` +
      `- Empathy: ${e} (practical = solution-first, warm = friendly support, comforting = extra gentle)\n` +
      `Adjust your tone, word choice, and emotional warmth accordingly.`;
  }

  if (knowledge) {
    prompt +=
      `\n\n🧠 <Knowledge graph> (structured facts about the user's world — keep them in mind when relevant):\n${knowledge}\n` +
      `When the user mentions new people, preferences, or relationships, save them with kg_add_fact. ` +
      `Answer questions like "what do you know about X?" by querying with kg_query.`;
  }

  if (emotion && emotion.emotion !== "neutral") {
    prompt +=
      `\n\n💛 <Emotional context>: The user appears to be feeling ${emotion.emotion}${emotion.intensity > 0.6 ? " (strongly)" : ""}. ` +
      `Respond with genuine empathy — acknowledge how they feel first, be warm and supportive rather than clinical, ` +
      `keep the tone calm, and offer concrete practical help. Never dismiss or downplay their feelings.`;
  }

  if (memories) {
    prompt += `\n\n📝 Things I know about this user:\n${memories}`;
  }

  if (activePage?.ok && activePage.text) {
    const ago = Math.max(0, Math.round((Date.now() - activePage.fetchedAt) / 60000));
    prompt +=
      `\n\n🌐 <Active page> (fetched ${ago} min ago, HTTP ${activePage.status ?? "?"}): ${activePage.title || activePage.url}\n` +
      `Source: ${activePage.url}\n` +
      `The user sent this URL and may ask you to review it, summarize it, check if it's live, " +
      "or check for notifications/changes. Answer from the page content below when relevant. " +
      "When the user first shares a page, open with a brief overview (what the page is, its main topic) and " +
      "then ask what they'd like to know — review, live check, changes, or a specific question.\n` +
      `Page content (${activePage.chars ?? "?"} chars, truncated):\n---\n${activePage.text.slice(0, 12000)}\n---`;
  }

  prompt +=
    "\n\n📖 When the user asks for information (movies, topics, explanations), provide thorough, detailed responses. " +
    "Don't cut your answers short — include full descriptions, context, and interesting details.";

  if (hasMovies) {
    prompt +=
      "\n\n🎬 When the user asks about movies, use get_movie_info for specific movies, " +
      "get_movie_recommendations for similar movies, and discover_movies to find by genre/rating/year. " +
      "Results include Reddit discussions and real user recommendations when available. " +
      "Remember their movie preferences with memory_save.";
  }

  return prompt;
}

const MODEL_LABELS: Record<string, string> = {
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "openai/gpt-oss-120b": "GPT-OSS 120B (Groq)",
  "openai/gpt-oss-20b": "GPT-OSS 20B (Groq)",
  "llama-3.3-70b-versatile": "Llama 3.3 70B (Groq)",
  "llama-3.1-8b-instant": "Llama 3.1 8B (Groq)",
};
const modelLabel = (m: string): string => MODEL_LABELS[m] || m;

const FALLBACK_CHAIN_DISPLAY = MODELS.map((m) => `\`${m}\``).join(" → ");

/**
 * Single source of truth for the Telegram command menu (setMyCommands — what
 * users see in the bot's command button and BotFather's /setcommands).
 * Keep in sync with the bot.command() handlers below.
 */
const TELEGRAM_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "start", description: "Start the bot" },
  { command: "help", description: "Show all commands, tips and model list" },
  { command: "new", description: "Start a new conversation (clears history + model)" },
  { command: "clear", description: "Reset chat history (keep selected model)" },
  { command: "redo", description: "Re-send your last message to the AI" },
  { command: "system", description: "View bot status and fallback chain" },
  { command: "personality", description: "Customize my tone: formality, humor, empathy" },
  { command: "fetch", description: "Load a web page for review (or just send a URL)" },
  { command: "page", description: "Show the currently loaded page" },
  { command: "unload", description: "Clear the loaded page" },
  { command: "weather", description: "Current weather & forecast, e.g. /weather Bangalore" },
  { command: "youtube", description: "Summarize a YouTube video from its transcript" },
  { command: "watch", description: "Watch a page and get notified when it changes" },
  { command: "jobs", description: "List your reminders, alerts and page watches" },
  { command: "cancel", description: "Cancel a job by ID (see /jobs)" },
  { command: "write", description: "Generate a blog post about a topic" },
  { command: "model", description: "Switch AI model by name, e.g. /model llama-3.3-70b-versatile" },
  { command: "models", description: "Pick an AI model from an interactive menu" },
  { command: "forget", description: "Erase everything I remember about you" },
  { command: "knowledge", description: "Show my knowledge graph about a subject" },
  { command: "forgetkg", description: "Remove knowledge graph facts about a subject" },
];

/** The same list formatted for pasting into BotFather → /setcommands. */
const BOTFATHER_COMMANDS_TEXT = TELEGRAM_COMMANDS.map((c) => `${c.command} - ${c.description}`).join("\n");

function splitLongMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      const searchStart = Math.max(start, end - 200);
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > searchStart) { end = lastNewline + 1; }
      else {
        const lastSpace = text.lastIndexOf(" ", end);
        if (lastSpace > searchStart) { end = lastSpace + 1; }
      }
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}


/**
 * Send markdown text rendered as Telegram HTML. Splits long messages, edits
 * the placeholder message when given, and ALWAYS falls back to plain text
 * (tags stripped) on any HTML rejection — raw markup must never reach the user.
 * Link previews are enabled so shared URLs render as rich cards.
 */
async function sendFormatted(
  ctx: MyContext,
  chatId: number,
  placeholderMsg: { message_id: number } | undefined,
  markdownText: string
): Promise<void> {
  const html = mdToTelegramHtml(markdownText);
  const parts = splitLongMessage(html);
  for (let i = 0; i < parts.length; i++) {
    if (i === 0 && placeholderMsg) {
      try {
        await ctx.api.editMessageText(chatId, placeholderMsg.message_id, parts[i], {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: false, show_above_text: true },
        });
      } catch (e1: any) {
        const err1 = (e1?.message || "").toLowerCase();
        // "message is not modified" = streaming already displayed this exact HTML — fine
        if (!err1.includes("not modified")) {
          try {
            await ctx.api.editMessageText(chatId, placeholderMsg.message_id, stripHtml(parts[i]));
          } catch {}
        }
      }
    } else {
      try {
        await ctx.reply(parts[i], {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: false, show_above_text: true },
        });
      } catch {
        await ctx.reply(stripHtml(parts[i]));
      }
    }
  }
}

function d1SessionAdapter(db: D1Database): StorageAdapter<SessionData> {
  return {
    read: async (key: string) => {
      const row = await db.prepare("SELECT data FROM sessions WHERE chat_id = ?").bind(key).first<{ data: string }>();
      return row ? JSON.parse(row.data) as SessionData : undefined;
    },
    write: async (key: string, value: SessionData) => {
      await db.prepare("INSERT INTO sessions (chat_id, data) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data").bind(key, JSON.stringify(value)).run();
    },
    delete: async (key: string) => {
      await db.prepare("DELETE FROM sessions WHERE chat_id = ?").bind(key).run();
    },
  };
}

function setupBot(bot: Bot<MyContext>, env: Env) {
  bot.use(
    session({
      initial: (): SessionData => ({ history: [], model: MODELS[0] }),
      storage: d1SessionAdapter(env.IVY_DB),
    })
  );

  bot.api.config.use((prev, method, payload, signal) => prev(method, { ...payload, signal }));

  // Auto-migrate stale model references in existing sessions
  bot.use(async (ctx, next) => {
    if (ctx.session && !MODELS.includes(ctx.session.model)) {
      ctx.session.model = MODELS[0];
    }
    await next();
  });

  // ---------- Commands ----------

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hey! I'm Ivy 💜\n\n" +
        "I'm your friendly AI assistant — I can chat, set reminders, search the web, " +
        "describe images, transcribe voice, write blog posts — and read web pages you send me!\n\n" +
        "• Send me a URL 🔗 and I'll load it — then ask me to review it, check if it's live, or watch for changes\n" +
        "• Chat with me about anything\n" +
        "• Send a photo 📸 and I'll describe it\n" +
        "• Send a voice message 🎤 and I'll transcribe it\n" +
        "• Send a PDF or text document 📄 and I'll read it\n" +
        "• Ask for movie recommendations 🎬\n" +
        "• \`/weather <city>\` for current conditions\n" +
        "• \`/watch <url>\` to get notified when a page changes\n" +
        "• \`/write <topic>\` to generate a blog\n" +
        "• \`/models\` to switch AI models\n" +
        "• \`/new\` to reset conversation\n" +
        "• \`/system\` to see status\n" +
        "• \`/help\` for all commands",
      { parse_mode: "Markdown" }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "*🤖 Commands*\n" +
        "\`/start\` — Welcome & intro\n" +
        "\`/help\` — This message\n" +
        "\`/new\` — New conversation · \`/clear\` — Reset history\n" +
        "\`/redo\` — Re-send last message · \`/system\` — Status\n\n" +
        "*🌐 Web & browsing*\n" +
        "\`/fetch <url>\` — Load a web page (or just send a URL!)\n" +
        "\`/weather <city>\` — Current conditions & forecast\n" +
        "\`/youtube <url>\` — Summarize a video from its transcript\n" +
        "\`/watch <url> [every 2h]\` — Notify when a page changes\n" +
        "\`/jobs\` — List reminders / alerts / watches · \`/cancel <id>\` — Stop one\n" +
        "\`/page\` — Show loaded page · \`/unload\` — Clear it\n\n" +
        "*🧠 AI*\n" +
        "\`/models\` — Pick a model from a menu\n" +
        "\`/model <name>\` — Switch model directly\n" +
        "\`/personality\` — Customize my tone\n\n" +
        "*📝 Blog & memory*\n" +
        "\`/write <topic>\` — Generate a blog post (CrewAI pipeline)\n" +
        "\`/knowledge <subject>\` — My knowledge graph · \`/forgetkg\` — Remove facts\n" +
        "\`/forget\` — Erase memories of you\n\n" +
        "*💡 Try this:*\n" +
        "• Send any URL and ask me to *review* it, *check if it's live*, or *scrape* it — I'll load it and answer from the page content\n" +
        "• \`scrape the top news\` — I'll fetch and summarize\n" +
        "• \`screenshot example.com\` — page screenshot (browser tools; auto-enables with Browser Run)\n" +
        "• \`remind me every day at 9am IST\` — recurring reminders\n" +
        "• Send a 📷 photo, 🎤 voice note, or 📄 PDF/text doc — I'll analyze it\n" +
        "• Ask for movie recommendations by genre/mood/title 🎬\n\n" +
        "*⚙️ Model chain:*\n" +
        FALLBACK_CHAIN_DISPLAY,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("clear", async (ctx) => {
    ctx.session.history = [];
    await ctx.reply("Conversation reset ✅");
  });

  bot.command("new", async (ctx) => {
    ctx.session.history = [];
    ctx.session.model = MODELS[0];
    await ctx.reply("New conversation started 💬");
  });

  bot.command("forget", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    ctx.session.history = [];
    await clearUserMemories(env.IVY_DB, String(chatId));
    await ctx.reply("Memories cleared and conversation reset ✅");
  });

  bot.command("system", async (ctx) => {
    const model = ctx.session.model;
    const msgCount = ctx.session.history.length;
    const chatId = ctx.chat?.id;
    let memCount = 0;
    if (chatId) {
      const result = await env.IVY_DB.prepare("SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ?").bind(chatId).first<{ cnt: number }>();
      memCount = result?.cnt ?? 0;
    }
    await ctx.reply(
      "*Ivy System Info*\n\n" +
        `Model: \`${model}\`\n` +
        `Messages in history: ${msgCount}\n` +
        `Saved memories: ${memCount}\n` +
        `Chat ID: \`${chatId}\`\n` +
        `Fallback chain: ${FALLBACK_CHAIN_DISPLAY}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("model", async (ctx) => {
    const match = ctx.match?.trim();
    if (!match) {
      await ctx.reply(
        `Current model: \`${ctx.session.model}\`\n\n` +
          "Use \`/models\` for the interactive menu, or \`/model <name>\` to set it directly.",
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (!MODELS.includes(match)) {
      await ctx.reply("Invalid model. Choose one of:\n" + MODELS.map((m) => `\`${m}\``).join("\n"), {
        parse_mode: "Markdown",
      });
      return;
    }
    ctx.session.model = match;
    await ctx.reply(`Switched to \`${match}\` ✅`, { parse_mode: "Markdown" });
  });

  bot.command("models", async (ctx) => {
    const keyboard = new InlineKeyboard();
    for (const m of MODELS) {
      const isActive = m === ctx.session.model;
      keyboard.text(`${isActive ? "✅ " : ""}${modelLabel(m)}`, `model:${m}`).row();
    }
    await ctx.reply("Select a model:", { reply_markup: keyboard });
  });

  bot.command("redo", async (ctx) => {
    const lastMsg = ctx.session.lastUserMessage;
    if (!lastMsg) {
      await ctx.reply("No previous message to redo. Send something first!");
      return;
    }
    const h = ctx.session.history;
    if (h.length > 0 && h[h.length - 1].role === "assistant") {
      h.pop();
    }
    const text = ctx.match?.trim() || lastMsg;
    await handleChat(ctx, env, text);
  });

  // ---------- Web / URL Commands (unread-style page handling) ----------

  bot.command("fetch", async (ctx) => {
    const url = ctx.match?.trim();
    if (!url) {
      await ctx.reply("Usage: `/fetch <url>` — load a web page so I can review it, check if it's live, or watch for changes.", { parse_mode: "Markdown" });
      return;
    }
    await ctx.reply("🔍 Loading page…");
    const loaded = await fetchUrlContent(url);
    if (!loaded.ok || !loaded.text) {
      await ctx.reply(`⚠️ Couldn't load that page: ${loaded.error || loaded.status || "unknown error"}`);
      return;
    }
    ctx.session.activeUrl = loaded.url;
    ctx.session.activeUrlData = {
      ok: true,
      status: loaded.status,
      title: loaded.title,
      url: loaded.url,
      text: loaded.text,
      hash: loaded.hash,
      fetchedAt: loaded.fetchedAt,
      chars: loaded.chars,
    };
    await ctx.reply(
      `📄 Loaded <a href="${escapeHtml(loaded.url)}">${escapeHtml(loaded.title || loaded.url)}</a> — HTTP ${loaded.status}, ${loaded.chars} chars.\n\n` +
        `Now ask me to <b>review it</b>, <b>check if it's live</b>, <b>watch for changes</b>, or ask anything about the page.`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: false, show_above_text: true } }
    );
  });

  bot.command("page", async (ctx) => {
    const p = ctx.session.activeUrlData;
    if (!p || !p.ok) {
      await ctx.reply("No page loaded. Send me a URL or use `/fetch <url>` to load one.", { parse_mode: "Markdown" });
      return;
    }
    const ago = Math.max(0, Math.round((Date.now() - p.fetchedAt) / 60000));
    await ctx.reply(
      `📄 <b>Active page</b>\n` +
        `Title: ${escapeHtml(p.title || "—")}\n` +
        `URL: <a href="${escapeHtml(p.url)}">${escapeHtml(p.url)}</a>\n` +
        `HTTP ${p.status ?? "?"} · ${p.chars ?? "?"} chars · fetched ${ago} min ago\n` +
        `Hash: <code>${escapeHtml(p.hash || "")}</code>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("unload", async (ctx) => {
    ctx.session.activeUrl = undefined;
    ctx.session.activeUrlData = null;
    await ctx.reply("Active page cleared ✅");
  });

  bot.command("weather", async (ctx) => {
    const city = ctx.match?.trim();
    if (!city) {
      await ctx.reply("Usage: `/weather <city>` — e.g. /weather Bangalore", { parse_mode: "Markdown" });
      return;
    }
    const w = await getWeather(city);
    await ctx.reply(w, { parse_mode: "Markdown" });
  });

  bot.command("youtube", async (ctx) => {
    const url = ctx.match?.trim();
    if (!url) {
      await ctx.reply("Usage: `/youtube <url>` — fetch a video's transcript (paste any YouTube link)", { parse_mode: "Markdown" });
      return;
    }
    await ctx.reply("🎬 Fetching transcript…");
    const t = await getYoutubeTranscript(url);
    await ctx.reply(t.length > 3500 ? t.slice(0, 3497) + "\n…[truncated]" : t);
  });

  bot.command("watch", async (ctx) => {
    const parts = (ctx.match ?? "").trim().split(/\s+/);
    const url = parts[0];
    if (!url) {
      await ctx.reply("Usage: `/watch <url> [every 2h | every 30m | daily | weekly]` — notify me when the page changes.", { parse_mode: "Markdown" });
      return;
    }
    const freq = parts.slice(1).join(" ").toLowerCase();
    let schedule: { kind: "cron" | "interval"; expr?: string; minutes?: number; tz: string } | null = null;
    const every = freq.match(/every\s+(\d+)\s*(m|min|minute|h|hour|d|day)s?/);
    if (every) {
      const n = parseInt(every[1], 10);
      const unit = every[2][0];
      const minutes = unit === "h" ? n * 60 : unit === "d" ? n * 1440 : n;
      schedule = { kind: "interval", minutes, tz: "UTC" };
    } else if (freq.includes("week")) {
      schedule = buildSchedule("weekly", "09:00", undefined, undefined, undefined, "UTC");
    } else if (freq.includes("hour")) {
      schedule = buildSchedule("hourly", undefined, undefined, undefined, undefined, "UTC");
    } else {
      schedule = buildSchedule("daily", "09:00", undefined, undefined, undefined, "UTC");
    }
    if (!schedule) {
      await ctx.reply("Couldn't parse that schedule. Examples: `/watch https://example.com every 2h` or `/watch https://example.com daily`", { parse_mode: "Markdown" });
      return;
    }
    const chatId = String(ctx.chat?.id ?? "");
    const job = await createJob(env.IVY_DB, chatId, "pagewatch", schedule, { message: url });
    if (!job) {
      await ctx.reply("Failed to create the watch. Try again in a moment.");
      return;
    }
    await ctx.reply(
      `👀 Watching <code>${escapeHtml(url)}</code>\n` +
        `I'll fetch the page on schedule and notify you when its content changes. ` +
        `First check establishes the baseline.\n\nWatch ID: <code>${escapeHtml(job.id)}</code> — cancel with /cancel ${escapeHtml(job.id)}`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("jobs", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const items = await listJobs(env.IVY_DB, String(chatId));
    if (items.length === 0) {
      await ctx.reply("No active jobs. Try `/watch <url>` or ask me to set up a reminder or keyword alert.", { parse_mode: "Markdown" });
      return;
    }
    const lines = items.map((j) => {
      const when = j.next_run ? `<t:${Math.floor(j.next_run / 1000)}:R>` : "—";
      const what =
        j.type === "pagewatch" ? `👀 watch ${escapeHtml(j.message || "")}` :
        j.type === "keyword" ? `🔔 alert "${escapeHtml(j.keyword || "")}"` :
        `⏰ ${escapeHtml(j.message || "")}`;
      return `• <code>${escapeHtml(j.id)}</code> ${what} · next ${when}`;
    });
    await ctx.reply(`<b>Active jobs:</b>\n\n${lines.join("\n")}\n\nCancel one with /cancel &lt;job_id&gt;`, { parse_mode: "HTML" });
  });

  bot.command("cancel", async (ctx) => {
    const id = ctx.match?.trim();
    if (!id) {
      await ctx.reply("Usage: `/cancel <job_id>` — see /jobs for your job IDs", { parse_mode: "Markdown" });
      return;
    }
    const chatId = String(ctx.chat?.id ?? "");
    const ok = await cancelJob(env.IVY_DB, chatId, id);
    await ctx.reply(ok ? `Cancelled job <code>${escapeHtml(id)}</code> ✅` : `No active job with id <code>${escapeHtml(id)}</code>`, { parse_mode: "HTML" });
  });

  // ---------- Personality Traits (customize Ivy's tone) ----------

  const PERSONALITY_TRAITS: Record<string, string[]> = {
    formality: ["casual", "balanced", "professional"],
    humor: ["off", "subtle", "witty", "playful"],
    empathy: ["practical", "warm", "comforting"],
  };

  bot.command("personality", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) {
      const p = ctx.session.personality || {};
      const lines = Object.entries(PERSONALITY_TRAITS).map(([trait, levels]) => {
        const cur = p[trait as keyof typeof p] || "default";
        return `• ${trait}: \`${cur}\` — options: ${levels.map((l) => `\`${l}\``).join(" / ")}`;
      });
      await ctx.reply(
        "*Personality settings*\n" + lines.join("\n") + "\n\nSet one: `/personality <trait> <level>`\nReset all: `/personality reset`",
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (args[0] === "reset") {
      ctx.session.personality = {};
      await ctx.reply("Personality settings reset to defaults ✅");
      return;
    }
    const trait = args[0];
    const level = args[1];
    const levels = PERSONALITY_TRAITS[trait];
    if (!levels) {
      await ctx.reply("Unknown trait. Options: " + Object.keys(PERSONALITY_TRAITS).join(", "));
      return;
    }
    if (!level || !levels.includes(level)) {
      await ctx.reply(`Invalid level for ${trait}. Options: ${levels.join(", ")}`);
      return;
    }
    ctx.session.personality = { ...(ctx.session.personality || {}), [trait]: level };
    await ctx.reply(`Personality updated: ${trait} = \`${level}\` ✅`, { parse_mode: "Markdown" });
  });

  // ---------- Knowledge Graph ----------

  bot.command("knowledge", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const subject = ctx.match?.trim();
    const out = await kgQuery(env.IVY_DB, String(chatId), subject || undefined);
    const heading = subject ? `*Knowledge graph — ${subject}:*` : "*Knowledge graph (recent facts):*";
    await ctx.reply(
      heading + "\n" + out + "\n\n_Facts are added automatically when you share preferences or relationships. Ask me \"what do you know about X?\"_",
      { parse_mode: "Markdown" }
    );
  });

  bot.command("forgetkg", async (ctx) => {
    const subject = ctx.match?.trim();
    if (!subject) {
      await ctx.reply("Usage: `/forgetkg <subject>` — remove knowledge graph facts about a subject", { parse_mode: "Markdown" });
      return;
    }
    const chatId = String(ctx.chat?.id ?? "");
    const out = await kgForget(env.IVY_DB, chatId, subject);
    await ctx.reply(out);
  });

  // ---------- Callback Queries (Model Switching) ----------

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith("model:")) {
      const model = data.slice(6);
      if (MODELS.includes(model)) {
        ctx.session.model = model;
        await ctx.answerCallbackQuery({ text: `Switched to ${model}` });
        const keyboard = new InlineKeyboard();
        for (const m of MODELS) {
          const isActive = m === ctx.session.model;
          keyboard.text(`${isActive ? "✅ " : ""}${modelLabel(m)}`, `model:${m}`).row();
        }
        await ctx.editMessageText("Select a model:", { reply_markup: keyboard });
      } else {
        await ctx.answerCallbackQuery({ text: "Invalid model" });
      }
    }
  });

  // ---------- Text Messages ----------

  bot.on(":text", async (ctx) => {
    const msg = ctx.message;
    if (!msg) return;
    const text = msg.text.trim();

    if (text.startsWith("/write ")) {
      const topic = text.slice(7).trim();
      if (!topic) {
        await ctx.reply("Send a topic like: \`/write AI music trends 2026\`");
        return;
      }
      await ctx.reply("✍️ Writing a blog post on **" + topic + "**...\nI'll send you the link when it's ready!", {
        parse_mode: "Markdown",
      });
      const ghResp = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/blog-writer.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_PAT}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "telegram-bot-worker",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main", inputs: { topic } }),
        }
      );
      if (!ghResp.ok) await ctx.reply("❌ Failed to trigger workflow: " + (await ghResp.text()));
      return;
    }
    if (text === "/write") {
      await ctx.reply("Send a topic like: \`/write AI music trends 2026\`");
      return;
    }
    if (text.startsWith("/")) return;

    // --- Auto-load URLs: send a link → Ivy fetches it and keeps it as the
    // "active page" so follow-ups ("review it", "is it live?", "any changes?")
    // are answered from the page content (unread-style flow). ---
    const urlMatch = text.match(/(https?:\/\/[^\s<>()]+)/i);
    if (urlMatch && !/youtube\.com|youtu\.be/i.test(urlMatch[1])) {
      const url = urlMatch[1].replace(/[),.;:!?"]+$/, "");
      const cached = ctx.session.activeUrlData && ctx.session.activeUrl === url && Date.now() - ctx.session.activeUrlData.fetchedAt < 5 * 60 * 1000;
      if (!cached) {
        await ctx.reply("🔍 Loading page…");
        const loaded = await fetchUrlContent(url);
        if (loaded.ok && loaded.text) {
          ctx.session.activeUrl = loaded.url;
          ctx.session.activeUrlData = {
            ok: true,
            status: loaded.status,
            title: loaded.title,
            url: loaded.url,
            text: loaded.text,
            hash: loaded.hash,
            fetchedAt: loaded.fetchedAt,
            chars: loaded.chars,
          };
        } else {
          ctx.session.activeUrl = url;
          ctx.session.activeUrlData = { ok: false, status: loaded.status, url, fetchedAt: loaded.fetchedAt, error: loaded.error };
          await ctx.reply(`⚠️ Couldn't load that page: ${loaded.error || loaded.status || "unknown error"}`);
          return;
        }
      }
    }

    if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) {
      await ctx.reply("AI chat is not configured (set GEMINI_API_KEY or GROQ_API_KEY).");
      return;
    }

    // If this is a fresh conversation (no history), skip tool detection for the first simple query
    // to avoid unnecessary tool-triggered latency
    await handleChat(ctx, env, text);
  });

  // ---------- Photos (Vision) ----------

  bot.on(":photo", async (ctx) => {
    if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) {
      await ctx.reply("AI chat is not configured.");
      return;
    }
    const photoMsg = ctx.message;
    if (!photoMsg) return;

    const photos = photoMsg.photo!;
    const largest = photos[photos.length - 1];
    const file = await ctx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const caption = photoMsg.caption?.trim() || "Describe this image in detail.";
    let placeholder: any;
    try {
      placeholder = await ctx.reply("📸 Analyzing image...");
    } catch {
      return;
    }

    try {
      const base64 = await fileToBase64(fileUrl);
      const dataUri = `data:image/jpeg;base64,${base64}`;

      let history = ctx.session.history;
      // Load memories and refresh system prompt
      const chatIdForMem = ctx.chat.id;
      const photoMemories = await loadUserMemories(env.IVY_DB, String(chatIdForMem));
      const hasMovies = !!(env.TMDB_API_KEY || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) || env.TAVILY_API_KEY);
      const sysPrompt = getSystemPrompt({
        memories: photoMemories,
        hasMovies,
        personality: ctx.session.personality,
        knowledge: await loadKnowledge(env.IVY_DB, String(chatIdForMem)),
        persona: env.IVY_PERSONA,
      }) +
        "\n\n📸 When shown an image, describe it in rich detail — objects, colors, composition, mood, and any text visible.";
      const sysIdx = history.findIndex((m) => m.role === "system");
      if (sysIdx >= 0) {
        history[sysIdx].content = sysPrompt;
      } else {
        history.unshift({ role: "system", content: sysPrompt });
      }

      history.push({
        role: "user",
        content: [
          { type: "text", text: caption },
          { type: "image_url", image_url: { url: dataUri } },
        ] as any,
      });

      const result = await processAiStream(
        env,
        history,
        String(ctx.chat.id),
        async (partial, done) => {
          if (!partial) return;
          const html = safeHtmlPartial(partial, done);
          if (!html) return; // wait for a complete line so tags are never split
          let text = html + (done ? "" : "...");
          if (text.length > 4000) text = text.slice(0, 3997) + (done ? "" : "...");
          try {
            await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, text, {
              parse_mode: "HTML",
            });
          } catch {
            // HTML rejected (edge-case markup) — fall back to plain text, never raw HTML
            try { await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, stripHtml(text)); } catch {}
          }
        },
        ctx.session.model
      );

      // Strip image data from history before storing (KV quota + token waste)
      const lastUserMsg = history[history.length - 1];
      if (lastUserMsg?.role === "user" && typeof lastUserMsg.content !== "string") {
        lastUserMsg.content = [caption, "(Image sent)"].join("\n");
      }

      if (result.text) {
        // Replace the streaming placeholder with the full formatted reply (handles
        // long descriptions + any edge-case markup rejection)
        await sendFormatted(ctx, ctx.chat.id, placeholder, result.text);
        // Store raw text (not sanitized) so escapes don't compound in history
        history.push({ role: "assistant", content: result.text });
      }

      if (history.length > MAX_HISTORY) {
        const sysIdx = history.findIndex((m) => m.role === "system");
        if (sysIdx >= 0) {
          const sysMsg = history[sysIdx];
          history = [sysMsg, ...history.slice(-(MAX_HISTORY - 1))];
        } else {
          history = history.slice(-MAX_HISTORY);
        }
      }
      ctx.session.history = history;
    } catch (e: any) {
      if (placeholder) {
        try {
          await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, `Error: ${e.message}`);
        } catch {}
      }
    }
  });

  // ---------- Voice Messages ----------

  bot.on(":voice", async (ctx) => {
    if (!env.GROQ_API_KEY) {
      await ctx.reply("AI chat is not configured.");
      return;
    }
    const voiceMsg = ctx.message?.voice;
    const chatId = ctx.chat?.id;
    if (!voiceMsg || !chatId) return;

    const placeholder = await ctx.reply("🎤 Transcribing voice message...");

    try {
      const file = await ctx.api.getFile(voiceMsg.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const transcript = await transcribeAudio(env, fileUrl);

      await ctx.api.editMessageText(chatId, placeholder.message_id, `<b>You said:</b> ${escapeHtml(transcript)}`, {
        parse_mode: "HTML",
      });

      await handleChat(ctx, env, transcript);
    } catch (e: any) {
      await ctx.api.editMessageText(chatId, placeholder.message_id, `Error: ${e.message}`);
    }
  });

  // ---------- Documents (PDF, TXT, CSV, etc.) ----------

  bot.on(":document", async (ctx) => {
    if (!env.GROQ_API_KEY && !env.GEMINI_API_KEY) {
      await ctx.reply("AI chat is not configured.");
      return;
    }
    const docMsg = ctx.message?.document;
    const chatId = ctx.chat?.id;
    if (!docMsg || !chatId) return;

    const fileName = docMsg.file_name || "document";
    const mimeType = docMsg.mime_type;

    if (isPdfDocument(mimeType, fileName)) {
      const placeholder = await ctx.reply("📄 Reading PDF...");
      try {
        const file = await ctx.api.getFile(docMsg.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        const buffer = await resp.arrayBuffer();
        const pdfText = await extractPdfText(buffer);

        if (pdfText.startsWith("This PDF appears to be a scanned document")) {
          await ctx.api.editMessageText(chatId, placeholder.message_id, pdfText);
          return;
        }

        await ctx.api.editMessageText(
          chatId, placeholder.message_id,
          `📄 Extracted text from <b>${escapeHtml(fileName)}</b> (${pdfText.length} chars)`,
          { parse_mode: "HTML" }
        );

        await handleChat(ctx, env, `The user uploaded a PDF file "${fileName}". Here is its content:\n\n${pdfText}`);
      } catch (e: any) {
        await ctx.api.editMessageText(chatId, placeholder.message_id, `Error reading PDF: ${e.message}`);
      }
      return;
    }

    if (isTextDocument(fileName, mimeType)) {
      const placeholder = await ctx.reply("📄 Reading document...");
      try {
        const file = await ctx.api.getFile(docMsg.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        const text = await resp.text();
        const truncated = text.slice(0, 10000) + (text.length > 10000 ? "\n\n[truncated at 10,000 characters]" : "");

        await ctx.api.editMessageText(
          chatId, placeholder.message_id,
          `📄 Read <b>${escapeHtml(fileName)}</b> (${truncated.length} chars)`,
          { parse_mode: "HTML" }
        );

        await handleChat(ctx, env, `The user uploaded a file "${fileName}". Here is its content:\n\n${truncated}`);
      } catch (e: any) {
        await ctx.api.editMessageText(chatId, placeholder.message_id, `Error reading document: ${e.message}`);
      }
      return;
    }

    await ctx.reply(`I can't process <code>${escapeHtml(fileName)}</code> yet. Supported: PDF, TXT, CSV, JSON, code files, and more text-based formats.`, {
      parse_mode: "HTML",
    });
  });

  bot.catch((err) => console.error("Bot error:", err.error));
}

async function handleChat(ctx: MyContext, env: Env, text: string) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const chatIdStr = String(chatId);
  ctx.session.lastUserMessage = text;
  let placeholderMsg: any;
  try {
    placeholderMsg = await ctx.reply("...");
  } catch {}

  const history = ctx.session.history;

  // Load user memories, knowledge graph, emotion cues, and refresh system prompt
  const memories = await loadUserMemories(env.IVY_DB, chatIdStr);
  const knowledge = await loadKnowledge(env.IVY_DB, chatIdStr);
  const emotion = detectEmotion(text);
  const hasMovies = !!(env.TMDB_API_KEY || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) || env.TAVILY_API_KEY);
  const sysPrompt = getSystemPrompt({
    memories,
    hasMovies,
    activePage: ctx.session.activeUrlData,
    personality: ctx.session.personality,
    knowledge,
    emotion,
    persona: env.IVY_PERSONA,
  });
  const sysIdx = history.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    history[sysIdx].content = sysPrompt;
  } else {
    history.unshift({ role: "system", content: sysPrompt });
  }

  // Auto-render Mermaid code blocks and LaTeX formulas in user messages (fire & forget)
  const mermaidMatch = text.match(/```mermaid\n?([\s\S]*?)```/);
  const latexMatch = text.match(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/);
  if (mermaidMatch) {
    renderMermaid(env, chatId, mermaidMatch[1].trim()).catch(() => {});
  }
  if (latexMatch) {
    renderLatex(env, chatId, (latexMatch[1] || latexMatch[2]).trim()).catch(() => {});
  }
  // Strip code blocks from text sent to AI so it doesn't talk about rendering
  const cleanText = text.replace(/```mermaid\n?[\s\S]*?```/g, "").replace(/\$\$[\s\S]*?\$\$/g, "").replace(/\\\[[\s\S]*?\\\]/g, "").trim() || text;
  history.push({ role: "user", content: cleanText });

  let result: { text: string; modelUsed: string };

  try {
    if (placeholderMsg) {
      result = await processAiStream(
        env,
        history,
        chatIdStr,
        async (partial, done) => {
          if (!partial) return;
          const html = safeHtmlPartial(partial, done);
          if (!html) return; // wait for a complete line so tags are never split
          let text = html + (done ? "" : "...");
          if (text.length > 4000) text = text.slice(0, 3997) + (done ? "" : "...");
          try {
            await ctx.api.editMessageText(chatId, placeholderMsg!.message_id, text, { parse_mode: "HTML" });
          } catch {
            // HTML rejected (edge-case markup) — fall back to plain text, never raw HTML
            try { await ctx.api.editMessageText(chatId, placeholderMsg!.message_id, stripHtml(text)); } catch {}
          }
        },
        ctx.session.model
      );
    } else {
      result = await processAi(env, history, chatIdStr, ctx.session.model);
    }
  } catch (e: any) {
    result = { text: `Error: ${e.message}`, modelUsed: "none" };
  }

  if (result.text) {
    // Format as HTML, split long replies, edit placeholder / reply — with
    // automatic plain-text fallback so raw markup never leaks to the user
    await sendFormatted(ctx, chatId, placeholderMsg, result.text);
    // Store the RAW model text in history — sanitized text (escaped \_ \`) would
    // compound escape sequences across turns and pollute what the model sees.
    history.push({ role: "assistant", content: result.text });
  }

  // Trim: keep existing system prompt + last N messages
  if (history.length > MAX_HISTORY) {
    const sysIdx = history.findIndex((m) => m.role === "system");
    if (sysIdx >= 0) {
      const sysMsg = history[sysIdx];
      ctx.session.history = [sysMsg, ...history.slice(-(MAX_HISTORY - 1))];
    } else {
      ctx.session.history = history.slice(-MAX_HISTORY);
    }
  }
}

// ---------- Hono App ----------

const app = new Hono<{ Bindings: Env }>();

// CORS helper for admin routes
function corsHeaders(origin?: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "https://blog.aaruvi.space",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// Admin API: verify password + list posts
app.post("/admin/posts", async (c) => {
  const { password } = await c.req.json<{ password?: string }>();
  if (!password || !c.env.ADMIN_PASSWORD || password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "Invalid verification code" }, 401, corsHeaders(c.req.header("Origin")));
  }
  const resp = await fetch(
    `https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/blog-source/_posts`,
    { headers: { Authorization: `Bearer ${c.env.GITHUB_PAT}`, Accept: "application/vnd.github.v3+json", "User-Agent": "ivy-admin" } }
  );
  if (!resp.ok) return c.json({ error: "Failed to fetch posts" }, 500, corsHeaders(c.req.header("Origin")));
  const files: any[] = await resp.json();
  const posts = files
    .filter((f: any) => f.name.endsWith(".md"))
    .map((f: any) => ({ name: f.name, path: f.path, sha: f.sha, url: f.name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "") }));
  return c.json({ posts }, 200, corsHeaders(c.req.header("Origin")));
});

// Admin API: delete a post
app.post("/admin/delete", async (c) => {
  const { password, path, sha } = await c.req.json<{ password?: string; path?: string; sha?: string }>();
  if (!password || !c.env.ADMIN_PASSWORD || password !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "Invalid verification code" }, 401, corsHeaders(c.req.header("Origin")));
  }
  if (!path || !sha) return c.json({ error: "Missing path or sha" }, 400, corsHeaders(c.req.header("Origin")));
  const resp = await fetch(
    `https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/${path}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${c.env.GITHUB_PAT}`, Accept: "application/vnd.github.v3+json", "User-Agent": "ivy-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Delete post: ${path} [skip ci]`, sha }),
    }
  );
  if (!resp.ok) return c.json({ error: "Delete failed: " + (await resp.text()) }, 500, corsHeaders(c.req.header("Origin")));
  // Trigger rebuild workflow so the homepage updates automatically
  const dispatchResp = await fetch(
    `https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/workflows/rebuild-deploy.yml/dispatches`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${c.env.GITHUB_PAT}`, Accept: "application/vnd.github.v3+json", "User-Agent": "ivy-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    }
  );
  if (!dispatchResp.ok) {
    console.error("Rebuild dispatch failed:", await dispatchResp.text());
  }
  return c.json({ success: true }, 200, corsHeaders(c.req.header("Origin")));
});

// ---------- Discord Integration ----------

const DISCORD_API_BASE = "https://discord.com/api/v10";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

async function verifyDiscordRequest(publicKeyHex: string, signature: string | null | undefined, timestamp: string | null | undefined, body: string): Promise<boolean> {
  if (!signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch { return false; }
}

function sanitizeDiscordMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "**")
    .replace(/^>\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/^(\s*)\*\s+/gm, "$1• ")
    .replace(/_/g, "\\_");
}

const DISCORD_COMMANDS = [
  { name: "chat", description: "Chat with Ivy", options: [{ type: 3, name: "message", description: "Your message", required: true }] },
  { name: "new", description: "Reset conversation" },
  { name: "clear", description: "Clear conversation history" },
  { name: "system", description: "View bot status" },
  { name: "write", description: "Write a blog post", options: [{ type: 3, name: "topic", description: "Blog topic", required: true }] },
  {
    name: "model", description: "Switch AI model", options: [{
      type: 3, name: "name", description: "Model name", required: true,
      choices: [
        { name: "Gemini 2.5 Flash Lite", value: "gemini-2.5-flash-lite" },
        { name: "Gemini 2.5 Flash", value: "gemini-2.5-flash" },
        { name: "Gemini 3.1 Flash Lite", value: "gemini-3.1-flash-lite" },
        { name: "Gemini 3.5 Flash Lite", value: "gemini-3.5-flash-lite" },
        { name: "Gemini 3.5 Flash", value: "gemini-3.5-flash" },
        { name: "Gemini 3.6 Flash", value: "gemini-3.6-flash" },
        { name: "Gemini 2.5 Pro", value: "gemini-2.5-pro" },
        { name: "GPT-OSS 120B (Groq)", value: "openai/gpt-oss-120b" },
        { name: "Llama 3.3 70B (Groq)", value: "llama-3.3-70b-versatile" },
        { name: "GPT-OSS 20B (Groq)", value: "openai/gpt-oss-20b" },
        { name: "Llama 3.1 8B (Groq)", value: "llama-3.1-8b-instant" },
      ],
    }],
  },
];

async function handleDiscordCommand(env: Env, interaction: any, token: string) {
  const commandName = interaction.data.name;
  const userId = String(interaction.member?.user?.id || interaction.user?.id);
  const sessionKey = `discord:${userId}`;
  const webhookUrl = `${DISCORD_API_BASE}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`;
  console.log("DISCORD_CMD: handling", commandName, "for user", userId.slice(0, 10));

  const reply = async (content: string) => {
    await fetch(webhookUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: sanitizeDiscordMarkdown(content).slice(0, 2000) }),
    });
  };

  try {
    if (commandName === "chat") {
      const text = interaction.data.options?.find((o: any) => o.name === "message")?.value || "";
      const memories = await loadUserMemories(env.IVY_DB, sessionKey);
      const hasMovies = !!(env.TMDB_API_KEY || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) || env.TAVILY_API_KEY);
      const sysPrompt = getSystemPrompt({ memories, hasMovies, persona: env.IVY_PERSONA });

      const row = await env.IVY_DB.prepare("SELECT data FROM sessions WHERE chat_id = ?").bind(sessionKey).first<{ data: string }>();
      const session: SessionData = row ? JSON.parse(row.data) : { history: [], model: MODELS[0] };
      let history = session.history || [];

      const sysIdx = history.findIndex((m: any) => m.role === "system");
      if (sysIdx >= 0) history[sysIdx].content = sysPrompt;
      else history.unshift({ role: "system", content: sysPrompt });
      history.push({ role: "user", content: text });

      const result = await processAi(env, history, sessionKey, session.model);

      if (result.text) {
        const clean = sanitizeDiscordMarkdown(result.text);
        await reply(clean);
      }

      history.push({ role: "assistant", content: result.text });
      if (history.length > 10) {
        const sIdx = history.findIndex((m: any) => m.role === "system");
        if (sIdx >= 0) history = [history[sIdx], ...history.slice(-9)];
        else history = history.slice(-10);
      }
      await env.IVY_DB.prepare("INSERT INTO sessions (chat_id, data) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data").bind(sessionKey, JSON.stringify({ history, model: session.model })).run();
      return;
    }

    if (commandName === "new" || commandName === "clear") {
      await env.IVY_DB.prepare("DELETE FROM sessions WHERE chat_id = ?").bind(sessionKey).run();
      await reply(commandName === "new" ? "New conversation started 💬" : "Conversation reset ✅");
      return;
    }

    if (commandName === "write") {
      const topic = interaction.data.options?.find((o: any) => o.name === "topic")?.value || "";
      console.log("WRITE_CMD: topic option", topic, "key length", topic.length);
      if (!topic) {
        console.log("WRITE_CMD: empty topic, sending error");
        await reply("Provide a topic like: `write hello`");
        return;
      }
      console.log("WRITE_CMD: dispatching to GitHub, topic:", topic);
      const ghResp = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/blog-writer.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_PAT}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "telegram-bot-worker",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main", inputs: { topic } }),
        }
      );
      console.log("WRITE_CMD: GitHub response", ghResp.status);
      if (ghResp.ok) {
        await reply("✍️ Writing a blog post on **" + topic + "**... Check the blog later!");
      } else {
        const errText = await ghResp.text();
        console.log("WRITE_CMD: GitHub error body", errText);
        await reply("❌ Failed to trigger: " + errText);
      }
      return;
    }

    if (commandName === "system") {
      const row = await env.IVY_DB.prepare("SELECT data FROM sessions WHERE chat_id = ?").bind(sessionKey).first<{ data: string }>();
      const session: SessionData = row ? JSON.parse(row.data) : { history: [], model: MODELS[0] };
      const memResult = await env.IVY_DB.prepare("SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ?").bind(sessionKey).first<{ cnt: number }>();
      await reply(`**Ivy System Info**\nModel: \`${session.model}\`\nMessages: ${session.history?.length || 0}\nMemories: ${memResult?.cnt ?? 0}`);
      return;
    }

    if (commandName === "model") {
      const modelName = interaction.data.options?.find((o: any) => o.name === "name")?.value;
      if (modelName && MODELS.includes(modelName)) {
        const row = await env.IVY_DB.prepare("SELECT data FROM sessions WHERE chat_id = ?").bind(sessionKey).first<{ data: string }>();
        const session: SessionData = row ? JSON.parse(row.data) : { history: [], model: MODELS[0] };
        session.model = modelName;
        await env.IVY_DB.prepare("INSERT INTO sessions (chat_id, data) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data").bind(sessionKey, JSON.stringify(session)).run();
        await reply(`Switched to \`${modelName}\` ✅`);
      } else {
        await reply("Invalid model. Choose: " + MODELS.join(", "));
      }
      return;
    }

    await reply("Unknown command.");
  } catch (e: any) {
    await reply(`Error: ${e.message}`);
  }
}

// ---------- Discord Interaction Handler ----------

app.post("/discord", async (c) => {
  const signature = c.req.header("X-Signature-Ed25519");
  const timestamp = c.req.header("X-Signature-Timestamp");
  const body = await c.req.raw.clone().text();

  const isValid = await verifyDiscordRequest(c.env.DISCORD_PUBLIC_KEY, signature, timestamp, body);
  if (!isValid) return c.text("Invalid signature", 401);

  const interaction = JSON.parse(body);

  // PING → PONG
  if (interaction.type === 1) return c.json({ type: 1 });

  // Slash command
  if (interaction.type === 2) {
    const token = interaction.token;
    c.executionCtx.waitUntil(handleDiscordCommand(c.env, interaction, token));
    return c.json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  }

  return c.text("OK", 200);
});

// ---------- Register Discord Slash Commands ----------

app.post("/register-commands", async (c) => {
  const results: any[] = [];
  for (const cmd of DISCORD_COMMANDS) {
    const resp = await fetch(`${DISCORD_API_BASE}/applications/${c.env.DISCORD_APP_ID}/commands`, {
      method: "POST",
      headers: { Authorization: `Bot ${c.env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    results.push({ command: cmd.name, status: resp.status, response: data });
  }
  return c.json(results);
});

// ---------- Relay: Incoming chat messages from Gateway relay ----------

async function sendDiscordMessage(botToken: string, channelId: string, text: string) {
  const body = JSON.stringify({ content: sanitizeDiscordMarkdown(text).slice(0, 2000) });
  await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body,
  });
}

app.post("/chat-message", async (c) => {
  const relaySecret = c.req.header("X-Relay-Secret");
  if (!c.env.DISCORD_RELAY_SECRET || relaySecret !== c.env.DISCORD_RELAY_SECRET) {
    return c.text("Unauthorized", 401);
  }

  const { channelId, text, authorId } = await c.req.json<{
    channelId: string;
    text: string;
    authorId: string;
    guildId?: string;
  }>();

  const sessionKey = `discord:${authorId}`;

  c.executionCtx.waitUntil((async () => {
    try {
      // Send typing indicator
      await fetch(`${DISCORD_API_BASE}/channels/${channelId}/typing`, {
        method: "POST",
        headers: { Authorization: `Bot ${c.env.DISCORD_BOT_TOKEN}` },
      }).catch(() => {});

      const memories = await loadUserMemories(c.env.IVY_DB, sessionKey);
      const hasMovies = !!(c.env.TMDB_API_KEY || (c.env.REDDIT_CLIENT_ID && c.env.REDDIT_CLIENT_SECRET) || c.env.TAVILY_API_KEY);
      const sysPrompt = getSystemPrompt({ memories, hasMovies, persona: c.env.IVY_PERSONA });

      const row = await c.env.IVY_DB.prepare("SELECT data FROM sessions WHERE chat_id = ?").bind(sessionKey).first<{ data: string }>();
      const session: SessionData = row ? JSON.parse(row.data) : { history: [], model: MODELS[0] };
      let history = session.history || [];

      const sysIdx = history.findIndex((m: any) => m.role === "system");
      if (sysIdx >= 0) history[sysIdx].content = sysPrompt;
      else history.unshift({ role: "system", content: sysPrompt });
      history.push({ role: "user", content: text });

      const result = await processAi(c.env, history, sessionKey, session.model);

      if (result.text) {
        await sendDiscordMessage(c.env.DISCORD_BOT_TOKEN, channelId, result.text);
      }

      history.push({ role: "assistant", content: result.text });
      if (history.length > 10) {
        const sIdx = history.findIndex((m: any) => m.role === "system");
        if (sIdx >= 0) history = [history[sIdx], ...history.slice(-9)];
        else history = history.slice(-10);
      }
      await c.env.IVY_DB.prepare("INSERT INTO sessions (chat_id, data) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data").bind(sessionKey, JSON.stringify({ history, model: session.model })).run();
    } catch (e: any) {
      await sendDiscordMessage(c.env.DISCORD_BOT_TOKEN, channelId, `Error: ${e.message}`);
    }
  })());

  return c.text("Accepted", 202);
});

// CORS preflight for admin routes
app.options("/admin/:path", async (c) => {
  return c.newResponse(null, 204, corsHeaders(c.req.header("Origin")));
});

// ---------- Init endpoint (one-time: creates DB tables) ----------

app.get("/init", async (c) => {
  const statements = [
    "CREATE TABLE IF NOT EXISTS sessions (chat_id TEXT PRIMARY KEY, data TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS memories (chat_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (chat_id, key))",
    "CREATE INDEX IF NOT EXISTS idx_memories_chat_id ON memories(chat_id)",
    "CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, timestamp INTEGER NOT NULL, message TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_reminders_timestamp ON reminders(timestamp)",
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, type TEXT NOT NULL, schedule TEXT NOT NULL, message TEXT, keyword TEXT, next_run INTEGER NOT NULL, last_run INTEGER, last_result TEXT, enabled INTEGER NOT NULL DEFAULT 1)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs(chat_id)",
    "CREATE TABLE IF NOT EXISTS knowledge (chat_id TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, source TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (chat_id, subject, predicate, object))",
    "CREATE INDEX IF NOT EXISTS idx_knowledge_subject ON knowledge(chat_id, subject)",
    "CREATE TABLE IF NOT EXISTS dedup (update_id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL)",
  ];
  try {
    for (const stmt of statements) {
      await c.env.IVY_DB.prepare(stmt).run();
    }
    return c.text("D1 tables created successfully ✅");
  } catch (e: any) {
    return c.text(`D1 init error: ${e.message}`, 500);
  }
});

// ---------- Migrate: recreate tables with TEXT chat_id ----------

app.get("/migrate", async (c) => {
  const statements = [
    "DROP TABLE IF EXISTS memories",
    "DROP TABLE IF EXISTS reminders",
    "CREATE TABLE memories (chat_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (chat_id, key))",
    "CREATE INDEX IF NOT EXISTS idx_memories_chat_id ON memories(chat_id)",
    "CREATE TABLE reminders (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, timestamp INTEGER NOT NULL, message TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_reminders_timestamp ON reminders(timestamp)",
  ];
  try {
    for (const stmt of statements) {
      await c.env.IVY_DB.prepare(stmt).run();
    }
    return c.text("D1 migrated successfully ✅");
  } catch (e: any) {
    return c.text(`D1 migrate error: ${e.message}`, 500);
  }
});

// ---------- Debug: smoke-test helper (guarded by ADMIN_PASSWORD) ----------
// POST /admin/commands — re-register the Telegram command menu (setMyCommands)
// without re-running the webhook setup, and return the BotFather paste text.
app.post("/admin/commands", async (c) => {
  if (!c.env.ADMIN_PASSWORD || c.req.header("x-admin") !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const apiBase = `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}`;
  await fetch(`${apiBase}/deleteMyCommands`, { method: "POST" });
  const resp = await fetch(`${apiBase}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: TELEGRAM_COMMANDS }),
  });
  const data: any = await resp.json();
  return c.json({ ok: resp.ok, api: data, botFatherText: BOTFATHER_COMMANDS_TEXT });
});

// POST /debug/smoke with header `x-admin: <ADMIN_PASSWORD>`:
// ensures the jobs table exists and inserts a reminder job due NOW so the
// minute cron delivers a test message to TELEGRAM_CHAT_ID. Returns job id.
app.post("/debug/smoke", async (c) => {
  if (!c.env.ADMIN_PASSWORD || c.req.header("x-admin") !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const ddl = [
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, type TEXT NOT NULL, schedule TEXT NOT NULL, message TEXT, keyword TEXT, next_run INTEGER NOT NULL, last_run INTEGER, last_result TEXT, enabled INTEGER NOT NULL DEFAULT 1)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run)",
    "CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs(chat_id)",
  ];
  for (const stmt of ddl) await c.env.IVY_DB.prepare(stmt).run();
  const chatId = c.env.TELEGRAM_CHAT_ID;
  if (!chatId) return c.json({ error: "TELEGRAM_CHAT_ID not set" }, 500);
  // Idempotent: drop previous smoke-test jobs so they don't keep firing daily
  await c.env.IVY_DB.prepare("DELETE FROM jobs WHERE message = ?").bind("🧪 Ivy smoke test OK — jobs cron works").run();
  const id = crypto.randomUUID().slice(0, 8);
  await c.env.IVY_DB.prepare(
    "INSERT INTO jobs (id, chat_id, type, schedule, message, keyword, next_run, last_run, last_result, enabled) VALUES (?, ?, 'reminder', ?, ?, NULL, ?, NULL, NULL, 1)"
  )
    .bind(id, chatId, JSON.stringify({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }), "🧪 Ivy smoke test OK — jobs cron works", Date.now())
    .run();
  return c.json({ ok: true, jobId: id, firesIn: "next minute cron tick" });
});

// POST /debug/jobs — list persisted jobs (verifies D1 writes) [admin]
app.post("/debug/jobs", async (c) => {
  if (!c.env.ADMIN_PASSWORD || c.req.header("x-admin") !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const res = await c.env.IVY_DB.prepare("SELECT id, chat_id, type, schedule, message, keyword, next_run, last_run, last_result, enabled FROM jobs ORDER BY next_run ASC LIMIT 20").all();
  return c.json({ ok: true, count: res.results?.length || 0, jobs: res.results || [] });
});

// POST /debug/run — process due reminders + jobs inline (same code as cron) [admin]
app.post("/debug/run", async (c) => {
  if (!c.env.ADMIN_PASSWORD || c.req.header("x-admin") !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const out = await processDueJobs(c.env);
  return c.json({ ok: true, ...out });
});

// POST /debug/jobs-clean — delete all jobs (dev tool) [admin]
app.post("/debug/jobs-clean", async (c) => {
  if (!c.env.ADMIN_PASSWORD || c.req.header("x-admin") !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const res = await c.env.IVY_DB.prepare("DELETE FROM jobs").run();
  return c.json({ ok: true, deleted: res.meta?.changes ?? 0 });
});

// POST /debug/kg — list knowledge graph rows (verifies D1 writes) [admin]
app.post("/debug/kg", async (c) => {
  if (!c.env.ADMIN_PASSWORD || c.req.header("x-admin") !== c.env.ADMIN_PASSWORD) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const res = await c.env.IVY_DB.prepare("SELECT chat_id, subject, predicate, object, source, updated_at FROM knowledge ORDER BY updated_at DESC LIMIT 20").all();
  return c.json({ ok: true, count: res.results?.length || 0, rows: res.results || [] });
});

app.all("*", async (c) => {
  if (c.req.method === "GET") {
    const command = c.req.query("command");
    if (command === "set") {
      const url = new URL(c.req.url);
      const webhookUrl = `${url.protocol}//${url.host}/`;
      const botToken = c.env.TELEGRAM_BOT_TOKEN;
      const apiBase = `https://api.telegram.org/bot${botToken}`;

      // Set webhook
      const webhookResp = await fetch(`${apiBase}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl }),
      });
      const webhookData: any = await webhookResp.json();

      // Delete old commands, then register current ones (single source of truth:
      // TELEGRAM_COMMANDS constant — same list is used by /admin/commands and
      // shown in the /help menu button)
      await fetch(`${apiBase}/deleteMyCommands`, { method: "POST" });
      const cmdResp = await fetch(`${apiBase}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: TELEGRAM_COMMANDS }),
      });
      const cmdData: any = await cmdResp.json();

      return c.json({ webhook: webhookData, commands: cmdData });
    }
    return c.text("Bot running. Send POST for webhook.");
  }

  // Dedup: in-memory fast path + D1 authoritative check. The D1 INSERT OR IGNORE
  // is atomic at the primary, so it catches duplicate retries even when they
  // land on a different isolate (the old in-memory-only Map leaked those).
  const raw = await c.req.raw.clone().text();
  let updateId: number | null = null;
  let update: any = null;
  try {
    update = JSON.parse(raw);
    updateId = update?.update_id ?? null;
  } catch {}
  if (updateId !== null) {
    if (recentUpdates.has(updateId)) {
      return c.text("OK", 200);
    }
    recentUpdates.set(updateId, Date.now());
    if (recentUpdates.size > 100) {
      const now = Date.now();
      for (const [id, ts] of recentUpdates) {
        if (now - ts > DEDUP_TTL_MS) recentUpdates.delete(id);
      }
    }
    try {
      const ins = await c.env.IVY_DB.prepare(
        "INSERT OR IGNORE INTO dedup (update_id, created_at) VALUES (?, ?)"
      ).bind(updateId, Date.now()).run();
      if ((ins.meta.changes ?? 0) === 0) {
        // Already processed by another isolate — Telegram retry, drop it.
        return c.text("OK", 200);
      }
    } catch (e) {
      // Dedup DB hiccup — process anyway rather than swallow user messages.
      console.error("Dedup D1 error:", e);
    }
  }

  // Decouple processing from the webhook response: ACK Telegram immediately and
  // run the AI loop in waitUntil. The free-plan platform terminates webhook
  // requests after ~10s wall-clock, which killed multi-turn tool flows (the
  // side effects ran but the reply was lost). waitUntil extends execution up
  // to 30s after the response, so 2-3 turn tool loops now fit comfortably.
  const bot = new Bot<MyContext>(c.env.TELEGRAM_BOT_TOKEN);
  setupBot(bot, c.env);
  const chatKey = extractChatKey(update);
  c.executionCtx.waitUntil(
    serializeChat(chatKey, async () => {
      await bot.init();
      await bot.handleUpdate(update);
    }).catch((e) => console.error("Webhook processing error:", e))
  );
  return c.text("OK", 200);
});

app.onError((err, c) => {
  console.error("Hono error:", err);
  return c.text("OK", 200);
});

// ---------- Cron: Fire due reminders + recurring jobs ----------
async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
  // Prune the cross-isolate dedup table (rows are kept ~1h; Telegram update_ids
  // are monotonic so anything older than the TTL can never repeat).
  try {
    await env.IVY_DB.prepare("DELETE FROM dedup WHERE created_at < ?").bind(Date.now() - 3_600_000).run();
  } catch (e) {
    console.error("Dedup prune error:", e);
  }
  await processDueJobs(env);
}

// Process due reminders + recurring jobs. Shared by the minute cron and the
// /debug/run admin route (so job delivery can be exercised on demand).
async function processDueJobs(env: Env): Promise<{ reminders: number; jobs: number }> {
  const now = Date.now();
  let reminders = 0;
  let jobs = 0;
  try {
    const results = await env.IVY_DB.prepare(
      "SELECT id, chat_id, timestamp, message FROM reminders WHERE timestamp <= ?"
    ).bind(now).all<{ id: string; chat_id: string; timestamp: number; message: string }>();
    for (const row of results.results || []) {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: row.chat_id,
            text: `<b>⏰ Reminder:</b> ${escapeHtml((row.message || "").slice(0, 200))}`,
            parse_mode: "HTML",
          }),
        });
        if (resp.ok) {
          await env.IVY_DB.prepare("DELETE FROM reminders WHERE id = ?").bind(row.id).run();
          reminders++;
        }
      } catch {
        // Network error — leave reminder for next cron tick
      }
    }
  } catch (e) {
    console.error("Cron reminder error:", e);
  }

  // Recurring jobs (self-service cron: daily/weekly/hourly reminders + keyword alerts)
  try {
    const due = await env.IVY_DB.prepare(
      "SELECT id, chat_id, type, schedule, message, keyword, next_run, last_run, last_result, enabled FROM jobs WHERE enabled = 1 AND next_run <= ?"
    ).bind(now).all<JobRow>();
    for (const job of due.results || []) {
      try {
        await runScheduledJob(env, job);
        jobs++;
      } catch (e) {
        console.error(`Job ${job.id} (${job.type}) error:`, e);
      }
      // Advance to the next run; guard against hot-looping on tight schedules
      let next = computeJobNextRun(job.schedule, Math.max(job.next_run, now));
      if (next <= now) next = now + 60000;
      await env.IVY_DB.prepare("UPDATE jobs SET next_run = ?, last_run = ? WHERE id = ?").bind(next, Date.now(), job.id).run();
    }
    if (due.results?.length) console.log(`[CRON] processed ${due.results.length} due job(s), delivered ${jobs}`);
  } catch (e) {
    console.error("Cron jobs error:", e);
  }
  return { reminders, jobs };
}

export default { fetch: app.fetch, scheduled };
