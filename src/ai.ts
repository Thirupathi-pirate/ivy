const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GROQ_API_KEY: string;
  TAVILY_API_KEY?: string;
  IVY_KV: KVNamespace;
}

interface GroqMessage {
  role: string;
  content?: string;
  tool_call_id?: string;
}

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface GroqChoice {
  message: {
    content?: string;
    tool_calls?: GroqToolCall[];
  };
}

interface GroqResponse {
  choices: GroqChoice[];
}

interface GroqRetry {
  _retry: boolean;
}

// ── Reminder helpers ──────────────────────────────────────────

async function createReminder(kv: KVNamespace, chatId: number, timeStr: string, message: string) {
  let timestamp: number;
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
  await kv.put(`reminder:${timestamp}:${id}`, JSON.stringify({ chat_id: chatId, message }));
  return { id, timestamp };
}

async function listReminders(kv: KVNamespace, chatId: number) {
  const list = await kv.list({ prefix: "reminder:" });
  const items: Array<{ id: string; timestamp: number; message: string }> = [];
  for (const key of list.keys) {
    const val: any = await kv.get(key.name, "json");
    if (val?.chat_id === chatId) {
      const parts = key.name.split(":");
      items.push({ id: parts[2], timestamp: parseInt(parts[1]), message: val.message });
    }
  }
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

async function cancelReminder(kv: KVNamespace, chatId: number, reminderId: string) {
  const list = await kv.list({ prefix: "reminder:" });
  for (const key of list.keys) {
    if (key.name.endsWith(`:${reminderId}`)) {
      const val: any = await kv.get(key.name, "json");
      if (val?.chat_id === chatId) {
        await kv.delete(key.name);
        return true;
      }
    }
  }
  return false;
}

// ── Web search ────────────────────────────────────────────────

async function searchWeb(apiKey: string, query: string) {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "advanced",
      max_results: 5,
      include_answer: true,
    }),
  });
  if (!resp.ok) return `Search failed (${resp.status})`;
  const data: any = await resp.json();
  if (!data.results?.length) return "No results found.";
  let out = data.answer ? `**Summary:** ${data.answer}\n\n` : "";
  out += data.results
    .map((r: any, i: number) => `${i + 1}. [${r.title}](${r.url}) — ${(r.content || "").slice(0, 300)}`)
    .join("\n\n");
  return out;
}

// ── Tool definitions ─────────────────────────────────────────

function getTools(env: Env) {
  const tools: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }> = [
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
        description: "Search the web for current information on a topic. Use this for research.",
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

// ── Groq calls ────────────────────────────────────────────────

async function callGroq(apiKey: string, messages: GroqMessage[], tools: any[], model?: string): Promise<GroqResponse | GroqRetry> {
  const body: Record<string, any> = {
    model: model || "mixtral-8x7b-32768",
    messages,
    max_tokens: 4096,
    temperature: 0.7,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const resp = await fetch(GROQ_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    if (tools.length && resp.status === 400 && err.includes("tool_use_failed")) {
      return { _retry: true };
    }
    throw new Error(`Groq API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

async function* streamGroq(apiKey: string, messages: GroqMessage[], model?: string) {
  const body = {
    model: model || "mixtral-8x7b-32768",
    messages,
    max_tokens: 4096,
    temperature: 0.7,
    stream: true,
  };
  const resp = await fetch(GROQ_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq stream error ${resp.status}: ${err.slice(0, 200)}`);
  }
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {}
    }
  }
}

// ── Orchestrator ──────────────────────────────────────────────

async function handleFunctionCall(
  env: Env,
  chatId: number,
  toolCall: GroqToolCall
): Promise<string> {
  const args = JSON.parse(toolCall.function.arguments);
  switch (toolCall.function.name) {
    case "create_reminder": {
      const result = await createReminder(env.IVY_KV, chatId, args.time, args.message);
      if (!result) return "Could not parse that time. Please use HH:MM format.";
      return JSON.stringify({
        status: "created",
        id: result.id,
        timestamp: result.timestamp,
        display: `<t:${Math.floor(result.timestamp / 1000)}:f>`,
        message: args.message,
      });
    }
    case "search_web":
      return await searchWeb(env.TAVILY_API_KEY!, args.query);
    case "list_reminders": {
      const items = await listReminders(env.IVY_KV, chatId);
      return JSON.stringify(
        items.map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          message: r.message,
          display: `<t:${Math.floor(r.timestamp / 1000)}:R>`,
        }))
      );
    }
    case "cancel_reminder": {
      const ok = await cancelReminder(env.IVY_KV, chatId, args.reminder_id);
      return JSON.stringify({ status: ok ? "cancelled" : "not_found" });
    }
    default:
      return `Unknown tool: ${toolCall.function.name}`;
  }
}

export async function streamAiResponse(
  env: Env,
  draft: { edit: (text: string) => Promise<any> },
  history: GroqMessage[],
  chatId: number,
  model?: string
) {
  const tools = getTools(env);
  let useTools = tools.length > 0;

  // Tool calling loop (non-streaming)
  for (let turn = 0; turn < 5; turn++) {
    const response = await callGroq(env.GROQ_API_KEY, history, useTools ? tools : [], model);
    if ("_retry" in response) {
      useTools = false;
      continue;
    }
    const message = (response as GroqResponse).choices[0].message;
    if (!message.tool_calls) {
      if (message.content) history.push({ role: "assistant", content: message.content });
      break;
    }
    history.push({ role: "assistant", content: message.content || "", tool_call_id: undefined });
    for (const tc of message.tool_calls) {
      const result = await handleFunctionCall(env, chatId, tc);
      history.push({ role: "tool", content: result, tool_call_id: tc.id });
    }
  }

  // Stream the final response
  let full = "";
  try {
    for await (const chunk of streamGroq(env.GROQ_API_KEY, history, model)) {
      full += chunk;
      if (full.length > 10) {
        await draft.edit(full);
      }
    }
  } catch (e: any) {
    if (!full) {
      const resp = await callGroq(env.GROQ_API_KEY, history, [], model);
      if (!("_retry" in resp)) {
        full = (resp as GroqResponse).choices?.[0]?.message?.content || "No response";
      }
    }
  }

  if (full) {
    await draft.edit(full);
    history.push({ role: "assistant", content: full });
  } else {
    await draft.edit("No response generated.");
  }
}
