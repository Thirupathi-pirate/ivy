// Cloudflare Worker — Telegram bot webhook for blog.aaruvi.space
// Only /write <topic> triggers GitHub Actions workflow.
// All other messages get a polite reply asking to use /write.

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Send POST", { status: 405 });
    }

    const update = await request.json();
    const msg = update.message;
    if (!msg || !msg.text) {
      return new Response("OK", { status: 200 });
    }

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Only respond to /write <topic> — ignore everything else
    if (!text.startsWith("/write")) {
      return new Response("OK", { status: 200 });
    }

    const topic = text.slice(6).trim();

    if (!topic) {
      const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Send a topic like: `/write AI music trends 2026`",
          parse_mode: "Markdown",
        }),
      });
      return new Response("OK", { status: 200 });
    }

    // Acknowledge
    const ackUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(ackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "✍️ Writing a blog post on **" + topic + "**...\nI'll send you the link when it's ready!",
        parse_mode: "Markdown",
      }),
    });

    // Trigger workflow
    const ghUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/daily-telegram.yml/dispatches`;
    const ghResponse = await fetch(ghUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_PAT}`,
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "telegram-bot-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: { topic: topic },
      }),
    });

    if (!ghResponse.ok) {
      const body = await ghResponse.text();
      const errUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      await fetch(errUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "❌ Failed to trigger workflow: " + body,
          parse_mode: "Markdown",
        }),
      });
    }

    return new Response("OK", { status: 200 });
  },
};
