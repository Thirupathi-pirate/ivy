const GROQ_API = "https://api.groq.com/openai/v1";

const FALLBACK_CHAIN = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GROQ_API_KEY: string;
  TAVILY_API_KEY?: string;
  IVY_KV: KVNamespace;
}

interface ChatMessage {
  role: string;
  content?: string | any[];
  tool_call_id?: string;
}

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type StreamCallback = (text: string, done: boolean) => Promise<void>;

// ===================== Long-Term Memory =====================

export async function loadUserMemories(kv: KVNamespace, chatId: number): Promise<string> {
  const list = await kv.list({ prefix: `memory:${chatId}:`, limit: 50 });
  const items: Array<{ key: string; value: string }> = [];
  for (const k of list.keys) {
    const keyName = k.name.slice(`memory:${chatId}:`.length);
    const val = await kv.get(k.name);
    if (val) items.push({ key: keyName, value: val });
  }
  if (!items.length) return "";
  return items.map((m) => `${m.key}: ${m.value}`).join("\n");
}

export async function clearUserMemories(kv: KVNamespace, chatId: number): Promise<void> {
  const list = await kv.list({ prefix: `memory:${chatId}:` });
  for (const k of list.keys) {
    await kv.delete(k.name);
  }
}

async function memorySave(kv: KVNamespace, chatId: number, key: string, value: string): Promise<string> {
  await kv.put(`memory:${chatId}:${key}`, value);
  return `Saved "${key}" = "${value}"`;
}

async function memoryRecall(kv: KVNamespace, chatId: number, key?: string): Promise<string> {
  if (key) {
    const val = await kv.get(`memory:${chatId}:${key}`);
    return val ?? `No memory found for "${key}".`;
  }
  const list = await kv.list({ prefix: `memory:${chatId}:`, limit: 50 });
  const items: Array<{ key: string; value: string }> = [];
  for (const k of list.keys) {
    const keyName = k.name.slice(`memory:${chatId}:`.length);
    const val = await kv.get(k.name);
    if (val) items.push({ key: keyName, value: val });
  }
  if (!items.length) return "No saved memories.";
  return items.map((m) => `• ${m.key}: ${m.value}`).join("\n");
}

// ===================== URL Fetch =====================

async function fetchUrl(url: string): Promise<string> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return `HTTP ${resp.status}: ${resp.statusText}`;
    const text = await resp.text();
    return text.slice(0, 8000) + (text.length > 8000 ? "\n\n[truncated]" : "");
  } catch (e: any) {
    return `Error fetching URL: ${e.message}`;
  }
}

// ===================== Time =====================

function getCurrentTime(timezone?: string): string {
  const now = new Date();
  if (timezone) {
    try {
      return now.toLocaleString("en-US", { timeZone: timezone });
    } catch {
      return `Invalid timezone. Current UTC: ${now.toISOString()}`;
    }
  }
  return now.toISOString();
}

// ===================== Reminder Tools =====================

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

// ===================== Tool Definitions =====================

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
    {
      type: "function",
      function: {
        name: "memory_save",
        description: "Save a fact or preference about the user to long-term memory so you can recall it across conversations. Call this whenever you learn something personal about the user.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Short descriptive key like 'name', 'favorite_color', 'job_title'" },
            value: { type: "string", description: "The value to remember" },
          },
          required: ["key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_recall",
        description: "Recall saved facts or preferences about the user from long-term memory.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Optional specific key to recall. Omit to list everything." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_url",
        description: "Fetch the content of a URL. Use this to read web pages, articles, docs, or API responses.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to fetch" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_current_time",
        description: "Get the current time, optionally in a specific timezone (e.g., 'America/New_York', 'Asia/Kolkata', 'UTC').",
        parameters: {
          type: "object",
          properties: {
            timezone: { type: "string", description: "Optional IANA timezone name" },
          },
        },
      },
    },
  ];
  if (env.TAVILY_API_KEY) {
    tools.push({
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web for current information on a topic. Use this for research and fact-checking.",
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

// ===================== Function Call Dispatcher =====================

async function handleFunctionCall(env: Env, chatId: number, toolCall: GroqToolCall): Promise<string> {
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
    case "search_web":
      return await searchWeb(env.TAVILY_API_KEY!, args.query);
    case "memory_save":
      return await memorySave(env.IVY_KV, chatId, args.key, args.value);
    case "memory_recall":
      return await memoryRecall(env.IVY_KV, chatId, args.key);
    case "fetch_url":
      return await fetchUrl(args.url);
    case "get_current_time":
      return getCurrentTime(args.timezone);
    default:
      return `Unknown tool: ${toolCall.function.name}`;
  }
}

// ===================== Groq API Call =====================

async function callGroq(
  apiKey: string,
  messages: ChatMessage[],
  tools: any[],
  model: string
): Promise<
  | { choices: Array<{ message: { content?: string; tool_calls?: GroqToolCall[] } }> }
  | { _rateLimited: true; model: string }
  | { _retry: true }
> {
  const body: Record<string, any> = { model, messages, max_tokens: 4096, temperature: 0.7 };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const resp = await fetch(`${GROQ_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.status === 429) return { _rateLimited: true, model };
  if (!resp.ok) {
    const err = await resp.text();
    if (tools.length && resp.status === 400 && err.includes("tool_use_failed")) return { _retry: true };
    throw new Error(`Groq API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

// ===================== Simulated Streaming =====================

async function revealText(onStream: StreamCallback | undefined, text: string) {
  if (!onStream || !text) return;
  const step = 25;
  let pos = Math.min(60, text.length);
  while (pos < text.length) {
    await onStream(text.slice(0, pos), false);
    pos = Math.min(pos + step, text.length);
  }
  await onStream(text, true);
}

// ===================== Main AI Processor with GOAP + Tool Loop =====================

async function processAiInternal(
  env: Env,
  messages: ChatMessage[],
  chatId: number,
  preferredModel: string | undefined,
  onStream?: StreamCallback,
  maxDepth = 5
): Promise<{ text: string; modelUsed: string }> {
  const tools = getTools(env);

  const chain = preferredModel && FALLBACK_CHAIN.includes(preferredModel)
    ? [preferredModel, ...FALLBACK_CHAIN.filter((m) => m !== preferredModel)]
    : FALLBACK_CHAIN;

  for (let attempt = 0; attempt < chain.length; attempt++) {
    const model = chain[attempt];
    const currentMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages));
    let useTools = tools.length > 0;

    for (let turn = 0; turn < maxDepth; turn++) {
      const response = await callGroq(env.GROQ_API_KEY, currentMessages, useTools ? tools : [], model);

      if ("_rateLimited" in response) break;
      if ("_retry" in response) {
        useTools = false;
        continue;
      }

      const msg = (response as any).choices[0].message;

      if (!msg.tool_calls) {
        const text = msg.content || "No response.";
        await revealText(onStream, text);
        return { text, modelUsed: model };
      }

      currentMessages.push({ role: "assistant", content: msg.content || "" });
      for (const tc of msg.tool_calls) {
        const result = await handleFunctionCall(env, chatId, tc);
        currentMessages.push({ role: "tool", content: result, tool_call_id: tc.id });
      }
    }
  }

  return { text: "I'm rate-limited across all models right now. Please try again in a minute 💜", modelUsed: "none" };
}

// ===================== Public API =====================

export async function processAi(
  env: Env,
  history: ChatMessage[],
  chatId: number,
  preferredModel?: string
): Promise<{ text: string; modelUsed: string }> {
  return processAiInternal(env, [...history], chatId, preferredModel);
}

export async function processAiStream(
  env: Env,
  history: ChatMessage[],
  chatId: number,
  onStream: StreamCallback,
  preferredModel?: string
): Promise<{ text: string; modelUsed: string }> {
  return processAiInternal(env, [...history], chatId, preferredModel, onStream);
}

// ===================== Voice Transcription =====================

export async function transcribeAudio(env: Env, fileUrl: string): Promise<string> {
  const audioResp = await fetch(fileUrl);
  const blob = await audioResp.blob();
  const formData = new FormData();
  formData.append("file", blob, "audio.ogg");
  formData.append("model", "whisper-large-v3-turbo");
  formData.append("response_format", "json");
  const resp = await fetch(`${GROQ_API}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: formData,
  });
  if (!resp.ok) throw new Error(`Transcription failed: ${resp.status}`);
  const data: any = await resp.json();
  return data.text || "";
}

// ===================== Image to base64 =====================

export async function fileToBase64(fileUrl: string): Promise<string> {
  const resp = await fetch(fileUrl);
  const blob = await resp.blob();
  const buffer = await blob.arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}
