import { Hono } from "hono";
import { Bot, Context, session, webhookCallback } from "grammy";
import { KvAdapter } from "@grammyjs/storage-cloudflare";
import { processAi } from "./ai";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GROQ_API_KEY: string;
  GITHUB_PAT: string;
  GITHUB_REPO: string;
  TAVILY_API_KEY?: string;
  IVY_KV: KVNamespace;
}

interface SessionData {
  history: Array<{ role: string; content?: string }>;
  model: string;
}

type MyContext = Context & { session: SessionData };

const MAX_HISTORY = 20;

const FALLBACK_CHAIN_DISPLAY = "`meta-llama/llama-4-scout-17b-16e-instruct` → `llama-3.3-70b-versatile` → `llama-3.1-8b-instant`";

const VALID_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

function setupBot(bot: Bot<MyContext>, env: Env) {
  bot.use(
    session({
      initial: () => ({ history: [], model: "meta-llama/llama-4-scout-17b-16e-instruct" }),
      storage: new KvAdapter(env.IVY_KV),
    })
  );

  bot.api.config.use((prev, method, payload, signal) => {
    return prev(method, { ...payload, signal });
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hey! I'm Ivy 💜\n\n" +
        "I'm your friendly AI assistant — I can chat, set reminders, search the web, and even help write blog posts!\n\n" +
        "• Chat with me about anything\n" +
        "• `/write <topic>` to generate a blog\n" +
        "• `/clear` to reset our conversation\n" +
        "• `/help` for all commands"
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "*Commands:*\n" +
        "`/write <topic>` — Generate a blog post\n" +
        "`/clear` — Reset chat history\n" +
        "`/model <name>` — Switch AI model\n\n" +
        "*Tips:*\n" +
        "• Ask for reminders (\"remind me at 14:30 to...\")\n" +
        "• Ask me to search the web\n" +
        "• I remember our conversations!\n\n" +
        "*Fallback chain:*\n" +
        FALLBACK_CHAIN_DISPLAY,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("clear", async (ctx) => {
    ctx.session.history = [];
    await ctx.reply("Conversation reset ✅");
  });

  bot.command("model", async (ctx) => {
    const match = ctx.match?.trim();
    if (!match) {
      await ctx.reply(
        `Current model: \`${ctx.session.model}\`\n\n` +
          `*Fallback chain:* ${FALLBACK_CHAIN_DISPLAY}\n\n` +
          "Use `/model <name>` to set your preferred model (tried first, falls back through the chain on rate limits).",
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (!VALID_MODELS.includes(match)) {
      await ctx.reply(
        "Invalid model. Choose one of:\n" + VALID_MODELS.map(m => `\`${m}\``).join("\n"),
        { parse_mode: "Markdown" }
      );
      return;
    }
    ctx.session.model = match;
    await ctx.reply(`Switched preferred model to \`${match}\` ✅`, { parse_mode: "Markdown" });
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith("/write ")) {
      const topic = text.slice(7).trim();
      if (!topic) {
        await ctx.reply("Send a topic like: `/write AI music trends 2026`");
        return;
      }
      await ctx.reply(
        "✍️ Writing a blog post on **" + topic + "**...\nI'll send you the link when it's ready!",
        { parse_mode: "Markdown" }
      );
      const ghResp = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/daily-telegram.yml/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_PAT}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "telegram-bot-worker",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: "main", inputs: { topic } }),
        }
      );
      if (!ghResp.ok) {
        await ctx.reply("❌ Failed to trigger workflow: " + (await ghResp.text()));
      }
      return;
    }

    if (text === "/write") {
      await ctx.reply("Send a topic like: `/write AI music trends 2026`");
      return;
    }

    if (!env.GROQ_API_KEY) {
      await ctx.reply("AI chat is not configured (GROQ_API_KEY not set).");
      return;
    }

    await ctx.api.sendChatAction(ctx.chat.id, "typing");

    let history = ctx.session.history;
    if (!history.length) {
      const system =
        "You are Ivy, a warm, friendly, and intelligent woman who helps with planning, reminders, and light research. " +
        "You're helpful, concise, and have a gentle sense of humor. " +
        "Keep responses friendly and natural, like a good friend who happens to be very knowledgeable. " +
        `Current UTC time is: ${new Date().toISOString()}`;
      history.push({ role: "system", content: system });
    }
    history.push({ role: "user", content: text });

    let reply = "";
    try {
      const result = await processAi(env, history, ctx.chat.id, ctx.session.model);
      reply = result.text;
    } catch (e: any) {
      reply = `Error: ${e.message}`;
    }

    if (reply) {
      await ctx.reply(reply, { parse_mode: "Markdown" });
      history.push({ role: "assistant", content: reply });
    }

    if (history.length > MAX_HISTORY) {
      const sysIdx = history.findIndex((m) => m.role === "system");
      history =
        sysIdx >= 0
          ? [history[sysIdx], ...history.slice(-(MAX_HISTORY - 1))]
          : history.slice(-MAX_HISTORY);
    }
    ctx.session.history = history;
  });

  bot.catch((err) => {
    console.error("Bot error:", err.error);
  });
}

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
