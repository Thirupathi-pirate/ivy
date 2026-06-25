import { Hono } from "hono";
import { Bot, Context, InlineKeyboard, session, webhookCallback } from "grammy";
import { KvAdapter } from "@grammyjs/storage-cloudflare";
import { processAi, processAiStream, transcribeAudio, fileToBase64, loadUserMemories, clearUserMemories, isTextDocument, isPdfDocument, extractPdfText, renderLatex, renderMermaid } from "./ai";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GROQ_API_KEY: string;
  GITHUB_PAT: string;
  GITHUB_REPO: string;
  TAVILY_API_KEY?: string;
  TMDB_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_USER_AGENT?: string;
  IVY_KV: KVNamespace;
}

interface SessionData {
  history: Array<{ role: string; content?: string }>;
  model: string;
  lastUserMessage?: string;
}

type MyContext = Context & { session: SessionData };

const MAX_HISTORY = 20;

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
    "\n\n💭 Before calling any tools, think through your approach inside <scratch_pad> tags. " +
    "Plan step by step — this helps you make better decisions and use the fewest tool calls possible." +
    "\n\n📖 When the user asks for information (movies, topics, explanations), provide thorough, detailed responses. " +
    "Don't cut your answers short — include full descriptions, context, and interesting details." +
    "\n\n📐 You have render_latex and render_mermaid tools that render math formulas and diagrams as images sent directly to the user. " +
    "IMPORTANT: When the user writes a LaTeX formula (with $$ or \\[\\]) or a Mermaid code block (\\`\\`\\`mermaid), you MUST call the corresponding tool to render it. " +
    "Do NOT say you can't send images — these tools exist specifically for that purpose.";

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
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

const FALLBACK_CHAIN_DISPLAY = MODELS.map((m) => `\`${m}\``).join(" → ");

function splitLongMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) parts.push(text.slice(i, i + maxLen));
  return parts;
}


/** Strip unsupported Telegram Markdown syntax before sending */
function sanitizeTelegramMarkdown(text: string): string {
  return text
    // Headings → plain text
    .replace(/^#{1,6}\s+/gm, "")
    // Blockquotes → plain text
    .replace(/^>\s+/gm, "")
    // * at line start → • (avoids italic interpretation)
    .replace(/^(\s*)\*\s+/gm, "$1• ");
}

function setupBot(bot: Bot<MyContext>, env: Env) {
  bot.use(
    session({
      initial: () => ({ history: [], model: MODELS[0] }),
      storage: new KvAdapter(env.IVY_KV),
    })
  );

  bot.api.config.use((prev, method, payload, signal) => prev(method, { ...payload, signal }));

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
    await ctx.reply("New conversation started 💬");
  });

  bot.command("forget", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    ctx.session.history = [];
    await clearUserMemories(env.IVY_KV, chatId);
    await ctx.reply("Memories cleared and conversation reset ✅");
  });

  bot.command("system", async (ctx) => {
    const model = ctx.session.model;
    const msgCount = ctx.session.history.length;
    const chatId = ctx.chat?.id;
    let memCount = 0;
    if (chatId) {
      const memList = await env.IVY_KV.list({ prefix: `memory:${chatId}:`, limit: 100 });
      memCount = memList.keys.filter((k) => !k.name.includes(":idx:")).length;
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

    if (!env.GROQ_API_KEY) {
      await ctx.reply("AI chat is not configured (GROQ_API_KEY not set).");
      return;
    }

    await handleChat(ctx, env, text);
  });

  // ---------- Photos (Vision) ----------

  bot.on(":photo", async (ctx) => {
    if (!env.GROQ_API_KEY) {
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
    const placeholder = await ctx.reply("📸 Analyzing image...");

    try {
      const base64 = await fileToBase64(fileUrl);
      const dataUri = `data:image/jpeg;base64,${base64}`;

      let history = ctx.session.history;
      // Load memories and refresh system prompt
      const chatIdForMem = ctx.chat.id;
      const photoMemories = await loadUserMemories(env.IVY_KV, chatIdForMem);
      const hasMovies = !!(env.TMDB_API_KEY || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) || env.TAVILY_API_KEY);
      const sysPrompt = getSystemPrompt(photoMemories, hasMovies).replace(
        "Keep responses friendly and natural, like a good friend who happens to be very knowledgeable.",
        "Keep responses friendly and natural, and describe images in detail when shown."
      );
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
        ctx.chat.id,
        async (partial, done) => {
          if (partial) {
            try {
              await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, partial + (done ? "" : "\n..."), {
                parse_mode: "Markdown",
              });
            } catch {}
          }
        },
        ctx.session.model
      );

      if (result.text) {
        history.push({ role: "assistant", content: result.text });
      }

      if (history.length > MAX_HISTORY) {
        const sysIdx = history.findIndex((m) => m.role === "system");
        history = sysIdx >= 0
          ? [history[sysIdx], ...history.slice(-(MAX_HISTORY - 1))]
          : history.slice(-MAX_HISTORY);
      }
      ctx.session.history = history;
    } catch (e: any) {
      await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, `Error: ${e.message}`);
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
    if (!env.GROQ_API_KEY) {
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
  if (msg.text && msg.entities) {
    for (const ent of msg.entities) {
      if (ent.type === "mention") {
        const mention = msg.text.slice(ent.offset, ent.offset + ent.length);
        if (mention === `@${me.username}`) return true;
      }
      if (ent.type === "text_mention" && ent.user?.id === me.id) return true;
    }
  }
  return false;
}

async function handleChat(ctx: MyContext, env: Env, text: string) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  ctx.session.lastUserMessage = text;
  let placeholderMsg: any;
  try {
    placeholderMsg = await ctx.reply("...");
  } catch {}

  const history = ctx.session.history;

  // Load user memories and refresh system prompt
  const memories = await loadUserMemories(env.IVY_KV, chatId);
  const hasMovies = !!(env.TMDB_API_KEY || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) || env.TAVILY_API_KEY);
  const sysPrompt = getSystemPrompt(memories, hasMovies);
  const sysIdx = history.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    history[sysIdx].content = sysPrompt;
  } else {
    history.unshift({ role: "system", content: sysPrompt });
  }

  history.push({ role: "user", content: text });

  // Auto-render Mermaid code blocks and LaTeX formulas in user messages
  (async () => {
    // Mermaid: ```mermaid ... ```
    const mermaidMatch = text.match(/```mermaid\n?([\s\S]*?)```/);
    if (mermaidMatch) {
      try {
        await renderMermaid(env, chatId, mermaidMatch[1].trim());
      } catch {}
    }
    // LaTeX: $$ ... $$ or \[ ... \]
    const latexMatch = text.match(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/);
    if (latexMatch) {
      try {
        await renderLatex(env, chatId, (latexMatch[1] || latexMatch[2]).trim());
      } catch {}
    }
  })();

  let result: { text: string; modelUsed: string };

  try {
    if (placeholderMsg) {
      result = await processAiStream(
        env,
        history,
        chatId,
        async (partial, done) => {
          if (partial) {
            try {
              await ctx.api.editMessageText(chatId, placeholderMsg!.message_id, partial + (done ? "" : "\n..."), {
                parse_mode: "Markdown",
              });
            } catch {}
          }
        },
        ctx.session.model
      );
    } else {
      result = await processAi(env, history, chatId, ctx.session.model);
    }
  } catch (e: any) {
    result = { text: `Error: ${e.message}`, modelUsed: "none" };
  }

  if (result.text) {
    const parts = splitLongMessage(sanitizeTelegramMarkdown(result.text));
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && placeholderMsg) {
        try {
          await ctx.api.editMessageText(chatId, placeholderMsg.message_id, parts[i], { parse_mode: "Markdown" });
        } catch {
          try { await ctx.api.editMessageText(chatId, placeholderMsg.message_id, parts[i]); } catch {
            await ctx.reply(parts[i]);
          }
        }
      } else {
        await ctx.reply(parts[i]);
      }
    }
    history.push({ role: "assistant", content: result.text });
  }

  // Trim: keep system prompt + last N messages
  if (history.length > MAX_HISTORY) {
    const sysIdx = history.findIndex((m) => m.role === "system");
    ctx.session.history = sysIdx >= 0
      ? [{ role: "system", content: getSystemPrompt(memories, hasMovies) }, ...history.slice(-(MAX_HISTORY - 1))]
      : history.slice(-MAX_HISTORY);
  }
}

// ---------- Hono App ----------

const app = new Hono<{ Bindings: Env }>();

app.all("*", async (c) => {
  if (c.req.method === "GET") {
    const command = c.req.query("command");
    if (command === "set") {
      const url = new URL(c.req.url);
      const webhookUrl = `${url.protocol}//${url.hostname}/`;
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

  const bot = new Bot<MyContext>(c.env.TELEGRAM_BOT_TOKEN);
  setupBot(bot, c.env);
  return webhookCallback(bot, "hono")(c);
});

app.onError((err, c) => {
  console.error("Hono error:", err);
  return c.text("OK", 200);
});

export default app;

// ---------- Cron: Fire due reminders ----------
export async function scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
  const list = await env.IVY_KV.list({ prefix: "reminder:", limit: 100 });
  const now = Date.now();
  for (const key of list.keys) {
    const val = await env.IVY_KV.get(key.name);
    if (!val) continue;
    const parts = key.name.split(":");
    if (parts.length < 4) continue;
    const chatId = parseInt(parts[1], 10);
    const timestamp = parseInt(parts[2], 10);
    if (isNaN(chatId) || isNaN(timestamp)) continue;
    if (timestamp <= now) {
      const message = val.slice(0, 200);
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `⏰ *Reminder:* ${message}`,
            parse_mode: "Markdown",
          }),
        });
      } catch {}
      await env.IVY_KV.delete(key.name);
    }
  }
}
