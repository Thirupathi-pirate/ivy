import { Hono } from "hono";
import { Bot, Context, InlineKeyboard, session, StorageAdapter, webhookCallback } from "grammy";
import { processAi, processAiStream, transcribeAudio, fileToBase64, loadUserMemories, clearUserMemories, isTextDocument, isPdfDocument, extractPdfText, renderLatex, renderMermaid } from "./ai";

// In-memory dedup for webhook update IDs (replaces KV to save quota)
const recentUpdates = new Map<number, number>();
const DEDUP_TTL_MS = 10_000;

interface Env {
  TELEGRAM_BOT_TOKEN: string;
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
}

interface SessionData {
  history: Array<{ role: string; content?: string }>;
  model: string;
  lastUserMessage?: string;
}

type MyContext = Context & { session: SessionData };

const MAX_HISTORY = 10;

function getSystemPrompt(memories?: string, hasMovies?: boolean): string {
  let prompt =
    "You are Ivy, a warm, friendly, and intelligent woman who helps with planning, reminders, and light research. " +
    "You're helpful and friendly, like a good friend who happens to be very knowledgeable. " +
    "Use memory_save to remember things the user tells you about themselves and memory_recall to retrieve them. " +
    "You have persistent memory across conversations — anything saved via memory_save is loaded automatically next time we talk. " +
    `Current UTC time is: ${new Date().toISOString()}`;

  if (memories) {
    prompt += `\n\n📝 Things I know about this user:\n${memories}`;
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

const MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
];

const FALLBACK_CHAIN_DISPLAY = MODELS.map((m) => `\`${m}\``).join(" → ");

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


/** Strip unsupported Telegram Markdown syntax before sending */
function sanitizeTelegramMarkdown(text: string): string {
  return text
    // Headings → plain text
    .replace(/^#{1,6}\s+/gm, "")
    // Blockquotes → plain text
    .replace(/^>\s+/gm, "")
    // Convert **bold** → *bold* (Telegram V1 only supports single *)
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    // * at line start → • (avoids italic interpretation)
    .replace(/^(\s*)\*\s+/gm, "$1• ")
    // Escape underscores to prevent accidental italic in variable names
    .replace(/_/g, "\\_")
    // Escape backticks to prevent accidental code blocks
    .replace(/`/g, "\\`");
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
        "describe images, transcribe voice, and write blog posts!\n\n" +
        "• Chat with me about anything\n" +
        "• Send a photo 📸 and I'll describe it\n" +
        "• Send a voice message 🎤 and I'll transcribe it\n" +
        "• Send a PDF or text document 📄 and I'll read it\n" +
        "• Ask for movie recommendations 🎬\n" +
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
      "*Commands:*\n" +
        "\`/write <topic>\` — Generate a blog post\n" +
        "\`/models\` — Switch AI model (inline keyboard)\n" +
        "\`/model <name>\` — Switch model by name\n" +
        "\`/new\` — Reset conversation\n" +
        "\`/redo\` — Re-send last message\n" +
        "\`/redo <text>\` — Re-send with edited text\n" +
        "\`/system\` — View bot status\n" +
        "\`/clear\` — Reset chat history\n" +
        "\`/help\` — This message\n\n" +
        "*Tips:*\n" +
        "• Ask for reminders (\"remind me at 14:30 to...\")\n" +
        "• Ask me to search the web\n" +
        "• Send a photo 📷 for analysis\n" +
        "• Send a voice note 🎤 for transcription\n" +
        "• Send a PDF or text document 📄 for analysis\n" +
        "• Ask for movie recommendations by genre/mood/title 🎬\n" +
        "• I remember facts about you across conversations 🧠\n" +
        "• Reply to my message in groups with @Ivy\n\n" +
        "*Models:*\n" +
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
      const label = m.replace("meta-llama/", "").replace("llama-", "");
      const isActive = m === ctx.session.model;
      keyboard.text(`${isActive ? "✅ " : ""}${label}`, `model:${m}`).row();
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
          const label = m.replace("meta-llama/", "").replace("llama-", "");
          const isActive = m === ctx.session.model;
          keyboard.text(`${isActive ? "✅ " : ""}${label}`, `model:${m}`).row();
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
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/daily-telegram.yml/dispatches`,
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

    // Group chat: only respond if bot is mentioned or replying to bot
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      if (!isBotMentioned(ctx)) return;
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
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      if (!isBotMentioned(ctx)) return;
    }

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
      const sysPrompt = getSystemPrompt(photoMemories, hasMovies) +
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
          if (partial) {
            const sanitized = sanitizeTelegramMarkdown(partial);
            let text = sanitized + (done ? "" : "\n...");
            if (text.length > 4000) text = text.slice(0, 3997) + (done ? "" : "...");
            try {
              await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, text, {
                parse_mode: "Markdown",
              });
            } catch {}
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
        history.push({ role: "assistant", content: sanitizeTelegramMarkdown(result.text) });
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

      await ctx.api.editMessageText(chatId, placeholder.message_id, `*You said:* ${transcript}`, {
        parse_mode: "Markdown",
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
          `📄 Extracted text from *${fileName}* (${pdfText.length} chars)`,
          { parse_mode: "Markdown" }
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
          `📄 Read *${fileName}* (${truncated.length} chars)`,
          { parse_mode: "Markdown" }
        );

        await handleChat(ctx, env, `The user uploaded a file "${fileName}". Here is its content:\n\n${truncated}`);
      } catch (e: any) {
        await ctx.api.editMessageText(chatId, placeholder.message_id, `Error reading document: ${e.message}`);
      }
      return;
    }

    await ctx.reply(`I can't process \`${fileName}\` yet. Supported: PDF, TXT, CSV, JSON, code files, and more text-based formats.`, {
      parse_mode: "Markdown",
    });
  });

  bot.catch((err) => console.error("Bot error:", err.error));
}

// ---------- Helpers ----------

function isBotMentioned(ctx: MyContext): boolean {
  const msg = ctx.message!;
  const me = ctx.me;
  if (msg.reply_to_message?.from?.id === me.id) return true;

  const checkEntities = (text: string, entities: readonly any[]) => {
    for (const ent of entities) {
      if (ent.type === "mention") {
        const mention = text.slice(ent.offset, ent.offset + ent.length);
        if (mention === `@${me.username}`) return true;
      }
      if (ent.type === "text_mention" && ent.user?.id === me.id) return true;
    }
    return false;
  };

  if (msg.text && msg.entities && checkEntities(msg.text, msg.entities)) return true;
  if (msg.caption && msg.caption_entities && checkEntities(msg.caption, msg.caption_entities)) return true;
  return false;
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

  // Load user memories and refresh system prompt
  const memories = await loadUserMemories(env.IVY_DB, chatIdStr);
  const hasMovies = !!(env.TMDB_API_KEY || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) || env.TAVILY_API_KEY);
  const sysPrompt = getSystemPrompt(memories, hasMovies);
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
          if (partial) {
            const sanitized = sanitizeTelegramMarkdown(partial);
            let text = sanitized + (done ? "" : "\n...");
            if (text.length > 4000) text = text.slice(0, 3997) + (done ? "" : "...");
            try {
              await ctx.api.editMessageText(chatId, placeholderMsg!.message_id, text, { parse_mode: "Markdown" });
            } catch {
              try { await ctx.api.editMessageText(chatId, placeholderMsg!.message_id, text); } catch {}
            }
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
    const text = sanitizeTelegramMarkdown(result.text);
    const parts = splitLongMessage(text);
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && placeholderMsg) {
        try {
          await ctx.api.editMessageText(chatId, placeholderMsg.message_id, parts[i], { parse_mode: "Markdown" });
        } catch (e1: any) {
          try { await ctx.api.editMessageText(chatId, placeholderMsg.message_id, parts[i]); } catch (e2: any) {
            const errMsg = (e2?.message || "").toLowerCase();
            // "message is not modified" means the stream already set it — that's fine
            if (!errMsg.includes("not modified")) {
              await ctx.reply(parts[i]);
            }
          }
        }
      } else {
        await ctx.reply(parts[i]);
      }
    }
    history.push({ role: "assistant", content: text });
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
      const sysPrompt = getSystemPrompt(memories, hasMovies);

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
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/daily-telegram.yml/dispatches`,
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
      const sysPrompt = getSystemPrompt(memories, hasMovies);

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

app.all("*", async (c) => {
  if (c.req.method === "GET") {
    const command = c.req.query("command");
    if (command === "set") {
      const url = new URL(c.req.url);
      const webhookUrl = `${url.protocol}//${url.host}/`;
      const resp = await fetch(
        `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl }),
        }
      );
      const data: any = await resp.json();
      return c.json(data);
    }
    return c.text("Bot running. Send POST for webhook.");
  }

  // Dedup: skip duplicate Telegram webhook retries (in-memory to save KV quota)
  const raw = await c.req.raw.clone().text();
  let updateId: number | null = null;
  try {
    const parsed = JSON.parse(raw);
    updateId = parsed?.update_id ?? null;
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
  }

  const bot = new Bot<MyContext>(c.env.TELEGRAM_BOT_TOKEN);
  setupBot(bot, c.env);
  return webhookCallback(bot, "hono")(c);
});

app.onError((err, c) => {
  console.error("Hono error:", err);
  return c.text("OK", 200);
});

// ---------- Cron: Fire due reminders ----------
async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
  const now = Date.now();
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
            text: `⏰ *Reminder:* ${(row.message || "").slice(0, 200)}`,
            parse_mode: "Markdown",
          }),
        });
        if (resp.ok) {
          await env.IVY_DB.prepare("DELETE FROM reminders WHERE id = ?").bind(row.id).run();
        }
      } catch {
        // Network error — leave reminder for next cron tick
      }
    }
  } catch (e) {
    console.error("Cron reminder error:", e);
  }
}

export default { fetch: app.fetch, scheduled };
