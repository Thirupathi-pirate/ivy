// Cloudflare Worker — Telegram bot webhook for blog.aaruvi.space
// Routes /write <topic> to GitHub Actions workflow_dispatch

export default {
  async fetch(request, env) {
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

    // Extract topic: "/write <topic>" or just plain text
    let topic = text;
    if (topic.startsWith("/write")) {
      topic = topic.slice(6).trim();
    }
    if (!topic) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        "Send a topic like: `/write AI music trends 2026`\n\nOr just send me any topic and I'll write about it!");
      return new Response("OK", { status: 200 });
    }

    // Acknowledge
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      "✍️ Writing a blog post on **" + topic + "**...\nThis takes a minute or two. I'll send you the link when it's ready!");

    // Trigger GitHub Actions
    const ghResponse = await triggerWorkflow(env.GITHUB_PAT, env.GITHUB_REPO, topic);

    if (!ghResponse.ok) {
      const body = await ghResponse.text();
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        "❌ Failed to trigger workflow: " + body);
    }

    return new Response("OK", { status: 200 });
  },
};

async function sendMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
  };
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function triggerWorkflow(pat, repo, topic) {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/daily-telegram.yml/dispatches`;
  return await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${pat}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "telegram-bot-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { topic: topic },
    }),
  });
}
