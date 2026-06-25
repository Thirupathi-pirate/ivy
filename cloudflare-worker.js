const TELEGRAM_API = "https://api.telegram.org";
const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const MAX_HISTORY = 20;

function sendTelegram(env, chatId, text, parseMode = "Markdown") {
  const url = `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
  });
}

async function getHistory(env, chatId) {
  try {
    const val = await env.IVY_KV.get(`chat:${chatId}`, "json");
    return Array.isArray(val) ? val : [];
  } catch {
    return [];
  }
}

async function saveHistory(env, chatId, history) {
  if (!env.IVY_KV) return;
  if (history.length > MAX_HISTORY) {
    const sysIdx = history.findIndex(m => m.role === "system");
    history = sysIdx >= 0
      ? [history[sysIdx], ...history.slice(-(MAX_HISTORY - 1))]
      : history.slice(-MAX_HISTORY);
  }
  await env.IVY_KV.put(`chat:${chatId}`, JSON.stringify(history));
}

async function callGroq(env, messages, tools) {
  const body = {
    model: "llama-3.3-70b-versatile",
    messages,
    max_tokens: 4096,
    temperature: 0.7,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const resp = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    if (tools?.length && resp.status === 400 && err.includes("tool_use_failed")) {
      return { _retry_without_tools: true };
    }
    throw new Error(`Groq API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

async function searchWeb(env, query) {
  if (!env.TAVILY_API_KEY) return "Web search is not available.";
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      search_depth: "advanced",
      max_results: 5,
      include_answer: true,
    }),
  });
  if (!resp.ok) return `Search failed (${resp.status})`;
  const data = await resp.json();
  if (!data.results?.length) return "No results found.";
  let out = data.answer ? `**Summary:** ${data.answer}\n\n` : "";
  out += data.results
    .map((r, i) => `${i + 1}. [${r.title}](${r.url}) — ${(r.content || "").slice(0, 300)}`)
    .join("\n\n");
  return out;
}

async function createReminder(env, chatId, timeStr, message) {
  if (!env.IVY_KV) return null;
  let timestamp;
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [h, m] = timeStr.split(":").map(Number);
    const t = new Date();
    t.setUTCHours(h, m, 0, 0);
    if (t <= new Date()) t.setUTCDate(t.getUTCDate() + 1);
    timestamp = t.getTime();
  } else {
    timestamp = new Date(timeStr).getTime();
    if (isNaN(timestamp)) return null;
  }
  const id = crypto.randomUUID().slice(0, 8);
  await env.IVY_KV.put(`reminder:${timestamp}:${id}`, JSON.stringify({ chat_id: chatId, message }));
  return { id, timestamp };
}

async function listReminders(env, chatId) {
  if (!env.IVY_KV) return [];
  const list = await env.IVY_KV.list({ prefix: "reminder:" });
  const items = [];
  for (const key of list.keys) {
    const val = await env.IVY_KV.get(key.name, "json");
    if (val?.chat_id === chatId) {
      const parts = key.name.split(":");
      items.push({ id: parts[2], timestamp: parseInt(parts[1]), message: val.message });
    }
  }
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

async function cancelReminder(env, chatId, reminderId) {
  if (!env.IVY_KV) return false;
  const list = await env.IVY_KV.list({ prefix: "reminder:" });
  for (const key of list.keys) {
    if (key.name.endsWith(`:${reminderId}`)) {
      const val = await env.IVY_KV.get(key.name, "json");
      if (val?.chat_id === chatId) {
        await env.IVY_KV.delete(key.name);
        return true;
      }
    }
  }
  return false;
}

const SYSTEM_PROMPT = `You are a helpful AI assistant for planning, reminders, and light research.

You have access to these tools:
- create_reminder: Schedule a reminder at a specific time (HH:MM format). Call this when the user asks to be reminded or notified at a certain time.
- search_web: Search the web for current information. Use this when the user asks for research, news, or up-to-date information.
- list_reminders: List all active reminders for the user.
- cancel_reminder: Cancel a reminder by its ID.

Guidelines:
- Keep responses concise, friendly, and natural.
- When the user asks for a reminder, confirm the time and message before creating it.
- When the user asks to search or research something, use search_web.
- For reminder management queries like "show my reminders" or "cancel reminder", use the appropriate tool.
- Current UTC time is: {NOW}`;

function getTools(env) {
  const tools = [
    {
      type: "function",
      function: {
        name: "create_reminder",
        description: "Schedule a reminder at a specific time. Call this when the user asks to be reminded or notified.",
        parameters: {
          type: "object",
          properties: {
            time: { type: "string", description: "Time in HH:MM (24-hour) format" },
            message: { type: "string", description: "The reminder message" },
          },
          required: ["time", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_reminders",
        description: "List all active reminders.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "cancel_reminder",
        description: "Cancel a reminder by its ID.",
        parameters: {
          type: "object",
          properties: {
            reminder_id: { type: "string", description: "The ID of the reminder to cancel" },
          },
          required: ["reminder_id"],
        },
      },
    },
  ];
  if (env.TAVILY_API_KEY) {
    tools.push({
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web for current information on a topic. Use this for research and finding up-to-date information.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
          },
          required: ["query"],
        },
      },
    });
  }
  return tools;
}

async function handleFunctionCall(env, chatId, toolCall) {
  const args = JSON.parse(toolCall.function.arguments);
  switch (toolCall.function.name) {
    case "create_reminder": {
      const result = await createReminder(env, chatId, args.time, args.message);
      if (!result) return "Could not parse that time. Please use HH:MM format.";
      const unix = Math.floor(result.timestamp / 1000);
      return JSON.stringify({
        status: "created",
        id: result.id,
        timestamp: result.timestamp,
        display: `<t:${unix}:f>`,
        message: args.message,
      });
    }
    case "search_web":
      return await searchWeb(env, args.query);
    case "list_reminders": {
      const items = await listReminders(env, chatId);
      return JSON.stringify(items.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        message: r.message,
        display: `<t:${Math.floor(r.timestamp / 1000)}:R>`,
      })));
    }
    case "cancel_reminder": {
      const ok = await cancelReminder(env, chatId, args.reminder_id);
      return JSON.stringify({ status: ok ? "cancelled" : "not_found" });
    }
    default:
      return `Unknown tool: ${toolCall.function.name}`;
  }
}

async function handleChat(env, chatId, text) {
  let history = await getHistory(env, chatId);
  if (!history.length) {
    history = [{ role: "system", content: SYSTEM_PROMPT.replace("{NOW}", new Date().toISOString()) }];
  }

  history.push({ role: "user", content: text });

  await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });

  const tools = getTools(env);
  let response;
  let useTools = tools.length > 0;

  try {
    response = await callGroq(env, history, useTools ? tools : []);
    if (response._retry_without_tools) {
      useTools = false;
      response = await callGroq(env, history, []);
    }
  } catch (e) {
    await sendTelegram(env, chatId, `Error: ${e.message}`, "HTML");
    return;
  }

  let message = response.choices[0].message;
  let turns = 0;

  while (message.tool_calls && useTools && turns < 5) {
    turns++;
    history.push(message);

    for (const tc of message.tool_calls) {
      const result = await handleFunctionCall(env, chatId, tc);
      history.push({ role: "tool", tool_call_id: tc.id, content: result });
    }

    await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });

    try {
      response = await callGroq(env, history, tools);
      if (response._retry_without_tools) {
        response = await callGroq(env, history, []);
        break;
      }
      message = response.choices[0].message;
    } catch (e) {
      await sendTelegram(env, chatId, `Error: ${e.message}`, "HTML");
      return;
    }
  }

  if (message.content) {
    history.push(message);
    await sendTelegram(env, chatId, message.content);
  }

  await saveHistory(env, chatId, history);
}

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

    if (text.startsWith("/write")) {
      const topic = text.slice(6).trim();
      if (!topic) {
        await sendTelegram(env, chatId, "Send a topic like: `/write AI music trends 2026`");
        return new Response("OK", { status: 200 });
      }

      await sendTelegram(env, chatId,
        "✍️ Writing a blog post on **" + topic + "**...\nI'll send you the link when it's ready!");

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
        await sendTelegram(env, chatId, "❌ Failed to trigger workflow: " + await ghResp.text());
      }

      return new Response("OK", { status: 200 });
    }

    if (!env.GROQ_API_KEY) {
      await sendTelegram(env, chatId, "AI chat is not configured (GROQ_API_KEY not set).", "HTML");
      return new Response("OK", { status: 200 });
    }

    ctx.waitUntil(handleChat(env, chatId, text));
    return new Response("OK", { status: 200 });
  },

  async scheduled(controller, env, ctx) {
    if (!env.IVY_KV) return;
    const now = Date.now();
    const list = await env.IVY_KV.list({ prefix: "reminder:" });

    for (const key of list.keys) {
      const parts = key.name.split(":");
      const timestamp = parseInt(parts[1]);
      if (timestamp > now) continue;

      const val = await env.IVY_KV.get(key.name, "json");
      if (val) {
        await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: val.chat_id,
            text: `⏰ *Reminder:* ${val.message}`,
            parse_mode: "Markdown",
          }),
        }).catch(() => {});
      }
      await env.IVY_KV.delete(key.name).catch(() => {});
    }
  },
};
