const GROQ_API = "https://api.groq.com/openai/v1";
import { escapeHtml, mdToTelegramHtml } from "./markdown";

export const MODELS = [
  // Gemini (primary chat provider) — ordered cheap/fast first, stronger later.
  // Each model has its own free-tier daily quota bucket, so more models = more
  // total daily capacity before the fallback chain hits the Groq last resort.
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-2.5-pro",
  // Groq (chat fallback + user-selectable) — fast free-tier chat; kept after
  // Gemini as provider-diverse last resorts. Order: quality first, speed last.
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];

const FALLBACK_CHAIN = [...MODELS];

const GEMINI_MODEL_MAP: Record<string, string> = {
  "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
  "gemini-3.5-flash": "gemini-3.5-flash",
  "gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
  "gemini-3.6-flash": "gemini-3.6-flash",
};

const GEMINI_MAX_TOKENS: Record<string, number> = {
  "gemini-2.5-flash": 65536,
  "gemini-2.5-flash-lite": 65536,
  "gemini-2.5-pro": 65536,
  "gemini-3.1-flash-lite": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-lite": 65536,
  "gemini-3.6-flash": 65536,
};

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GROQ_API_KEY: string;
  GEMINI_API_KEY?: string;
  TAVILY_API_KEY?: string;
  TMDB_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_USER_AGENT?: string;
  IVY_DB: D1Database;
  /** Owner-provided persona override (set via `wrangler secret put IVY_PERSONA`). */
  IVY_PERSONA?: string;
}

interface ChatMessage {
  role: string;
  content?: string | any[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: GroqToolCall[];
}

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Gemini thinking models require the functionCall's thought_signature to be
   *  echoed back on the next turn — preserve it across the tool loop. */
  thoughtSignature?: string;
}

export type StreamCallback = (text: string, done: boolean) => Promise<void>;

// ===================== Long-Term Memory =====================

export async function loadUserMemories(db: D1Database, chatId: string): Promise<string> {
  const results = await db.prepare("SELECT key, value FROM memories WHERE chat_id = ? LIMIT 50").bind(chatId).all<{ key: string; value: string }>();
  if (!results.results?.length) return "";
  return results.results.map((m) => `${m.key}: ${m.value}`).join("\n");
}

export async function clearUserMemories(db: D1Database, chatId: string): Promise<void> {
  await db.prepare("DELETE FROM memories WHERE chat_id = ?").bind(chatId).run();
}

async function memorySave(db: D1Database, chatId: string, key: string, value: string): Promise<string> {
  await db.prepare("INSERT INTO memories (chat_id, key, value) VALUES (?, ?, ?) ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value").bind(chatId, key, value).run();
  return `Saved "${key}" = "${value}"`;
}

async function memoryRecall(db: D1Database, chatId: string, key?: string): Promise<string> {
  if (key) {
    const row = await db.prepare("SELECT value FROM memories WHERE chat_id = ? AND key = ?").bind(chatId, key).first<{ value: string }>();
    return row?.value ?? `No memory found for "${key}".`;
  }
  const results = await db.prepare("SELECT key, value FROM memories WHERE chat_id = ? LIMIT 50").bind(chatId).all<{ key: string; value: string }>();
  if (!results.results?.length) return "No saved memories.";
  return results.results.map((m) => `• ${m.key}: ${m.value}`).join("\n");
}

// ===================== Emotional Intelligence =====================
// Lightweight heuristic: detects emotional cues so the bot can respond with
// genuine empathy (the LLM does the actual empathetic writing — this just
// nudges the system prompt when the user is clearly upset/happy/etc).

const EMOTION_CUES: Record<string, { words: string[]; emojis: string[]; weight: number }> = {
  sad: {
    words: ["sad", "depressed", "depressing", "lonely", "crying", "cry", "heartbroken", "hopeless", "miserable", "upset", "down", "grief", "grieving", "hurt", "in tears", "lost someone", "broke up", "failed"],
    emojis: ["😢", "😭", "💔", "🥺"],
    weight: 2,
  },
  anxious: {
    words: ["anxious", "worried", "worry", "stressed", "stress", "scared", "nervous", "panic", "panicking", "overwhelmed", "afraid", "fear", "uneasy", "can't sleep", "cant sleep", "on edge", "dreading"],
    emojis: ["😰", "😟", "😬"],
    weight: 2,
  },
  angry: {
    words: ["angry", "furious", "hate", "frustrated", "annoyed", "pissed", "irritated", "unfair", "fed up", "sick of", "rage", "fuming"],
    emojis: ["😡", "🤬", "😤"],
    weight: 2,
  },
  happy: {
    words: ["happy", "excited", "amazing", "awesome", "great news", "thrilled", "delighted", "love it", "fantastic", "yay", "celebrate", "passed", "got the job", "promoted", "engaged"],
    emojis: ["😄", "🎉", "🥳", "😁"],
    weight: 1.5,
  },
  grateful: {
    words: ["thank you", "thanks so much", "grateful", "appreciate", "thankful", "means a lot"],
    emojis: ["🙏"],
    weight: 1.5,
  },
};

export function detectEmotion(text: string): { emotion: string; intensity: number; cues: string[] } {
  const lower = text.toLowerCase();
  const scores = new Map<string, { score: number; cues: string[] }>();
  for (const [emotion, cfg] of Object.entries(EMOTION_CUES)) {
    let score = 0;
    const cues: string[] = [];
    for (const w of cfg.words) {
      if (lower.includes(w)) {
        score += cfg.weight;
        cues.push(w);
      }
    }
    for (const e of cfg.emojis) {
      if (text.includes(e)) {
        score += 2;
        cues.push(e);
      }
    }
    if (score > 0) scores.set(emotion, { score, cues });
  }
  if (scores.size === 0) return { emotion: "neutral", intensity: 0, cues: [] };
  const best = [...scores.entries()].sort((a, b) => b[1].score - a[1].score)[0];
  return { emotion: best[0], intensity: Math.min(1, best[1].score / 5), cues: best[1].cues.slice(0, 4) };
}

// ===================== Knowledge Graph =====================
// Structured triple store (subject → predicate → object) per chat. Grows as
// the user shares facts, preferences, and relationships; injected into the
// system prompt so answers stay accurate and relevant across conversations.

export async function kgAddFact(db: D1Database, chatId: string, subject: string, predicate: string, object: string, source?: string): Promise<string> {
  const s = subject.trim();
  const p = predicate.trim();
  const o = object.trim();
  if (!s || !p || !o) return "Error: subject, predicate and object are all required.";
  await db
    .prepare(
      "INSERT INTO knowledge (chat_id, subject, predicate, object, source, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(chat_id, subject, predicate, object) DO UPDATE SET source = excluded.source, updated_at = excluded.updated_at"
    )
    .bind(chatId, s, p, o, source ?? null, Date.now())
    .run();
  return `Saved to knowledge graph: ${s} → ${p} → ${o}`;
}

export async function kgQuery(db: D1Database, chatId: string, subject?: string, limit = 30): Promise<string> {
  let rows;
  if (subject && subject.trim()) {
    rows = await db
      .prepare("SELECT subject, predicate, object FROM knowledge WHERE chat_id = ? AND subject LIKE ? ORDER BY updated_at DESC LIMIT ?")
      .bind(chatId, `%${subject.trim()}%`, limit)
      .all<{ subject: string; predicate: string; object: string }>();
  } else {
    rows = await db
      .prepare("SELECT subject, predicate, object FROM knowledge WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?")
      .bind(chatId, limit)
      .all<{ subject: string; predicate: string; object: string }>();
  }
  if (!rows.results?.length) return subject ? `No knowledge graph facts found for "${subject}".` : "No facts in your knowledge graph yet.";
  return rows.results.map((r) => `• ${r.subject} → ${r.predicate} → ${r.object}`).join("\n");
}

export async function kgForget(db: D1Database, chatId: string, subject: string): Promise<string> {
  const res = await db.prepare("DELETE FROM knowledge WHERE chat_id = ? AND subject LIKE ?").bind(chatId, `%${subject.trim()}%`).run();
  return (res.meta.changes ?? 0) > 0 ? `Removed ${res.meta.changes} fact(s) about "${subject.trim()}".` : `No facts found about "${subject.trim()}".`;
}

/** Recent knowledge triples, one per line — for injection into the system prompt. */
export async function loadKnowledge(db: D1Database, chatId: string, limit = 15): Promise<string> {
  const rows = await db
    .prepare("SELECT subject, predicate, object FROM knowledge WHERE chat_id = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(chatId, limit)
    .all<{ subject: string; predicate: string; object: string }>();
  if (!rows.results?.length) return "";
  return rows.results.map((r) => `${r.subject} → ${r.predicate} → ${r.object}`).join("\n");
}

// ===================== URL Fetch =====================

export interface UrlFetchResult {
  ok: boolean;
  status?: number;
  title?: string;
  url: string;
  text?: string;
  hash?: string;
  fetchedAt: number;
  chars?: number;
  error?: string;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Decode HTML entities (&amp; &#39; &#x27; &nbsp; …) */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
    lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D", copy: "©", reg: "®", trade: "™",
    middot: "·", bull: "•", deg: "°", times: "×", divide: "÷", plusmn: "±", para: "¶", sect: "§",
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

/** FNV-1a 32-bit hash → stable content fingerprint for change detection */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Strip script/style/nav cruft from raw HTML, keep headings + lists, return clean text */
function htmlToText(raw: string): { title?: string; text: string } {
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "").trim()).slice(0, 200) : undefined;

  let html = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head)[^>]*\/>/gi, "");

  // Turn block boundaries into newlines before stripping tags
  html = html.replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre|table|ul|ol)>/gi, "\n");

  let text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u00a0\u200b]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  text = decodeEntities(text);
  if (!title) {
    const firstLine = text.split("\n").find((l) => l.trim().length > 8);
    title = firstLine?.trim().slice(0, 200);
  }
  return { title, text };
}

const MAX_HTML_BYTES = 5_000_000; // unread-style hard cap on raw HTML

/**
 * Fetch a URL and extract readable content (title + clean text + fingerprint).
 * Unread-style: browser UA, size cap, HTML→text extraction with nav cruft removed.
 */
export async function fetchUrlContent(rawUrl: string): Promise<UrlFetchResult> {
  const fetchedAt = Date.now();
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const finalUrl = resp.url || url;
    if (!resp.ok) return { ok: false, status: resp.status, url: finalUrl, fetchedAt, error: `HTTP ${resp.status}` };

    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("text/") && !contentType.includes("html") && !contentType.includes("json") && !contentType.includes("xml")) {
      return { ok: false, status: resp.status, url: finalUrl, fetchedAt, error: `Not a web page (${contentType.split(";")[0] || "unknown type"})` };
    }

    const text = await resp.text();
    if (text.length > MAX_HTML_BYTES) {
      return { ok: false, status: resp.status, url: finalUrl, fetchedAt, error: "Page is too large (>5 MB)" };
    }

    const isHtml = contentType.includes("html") || /<html[\s>]/i.test(text.slice(0, 2000));
    if (isHtml) {
      const { title, text: clean } = htmlToText(text);
      if (!clean) {
        return { ok: false, status: resp.status, url: finalUrl, fetchedAt, error: "Appears to be a JavaScript-rendered page — no readable text" };
      }
      return { ok: true, status: resp.status, title, url: finalUrl, text: clean, hash: contentHash(clean), fetchedAt, chars: clean.length };
    }

    // Plain text / JSON / XML
    const clean = text.replace(/\r\n/g, "\n").slice(0, 30000);
    return { ok: true, status: resp.status, title: url, url: finalUrl, text: clean, hash: contentHash(clean), fetchedAt, chars: clean.length };
  } catch (e: any) {
    return { ok: false, url, fetchedAt, error: e?.name === "TimeoutError" ? "Request timed out" : e?.message || "Fetch failed" };
  }
}

/** Tool-facing string form (kept for the fetch_url tool) */
async function fetchUrl(url: string): Promise<string> {
  const r = await fetchUrlContent(url);
  if (!r.ok) return `Error fetching URL: ${r.error}`;
  const head = `📄 ${r.title || ""} (HTTP ${r.status}, ${r.chars} chars)\nSource: ${r.url}\n\n`;
  return head + (r.text || "").slice(0, 15000) + ((r.text?.length || 0) > 15000 ? "\n\n[truncated]" : "");
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

// ===================== Timezone + Cron (self-service jobs) =====================

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const tzFmtCache = new Map<string, Intl.DateTimeFormat>();
function getTzFmt(tz: string): Intl.DateTimeFormat {
  let fmt = tzFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    tzFmtCache.set(tz, fmt);
  }
  return fmt;
}

/** Wall-clock parts of `ms` in an IANA timezone */
function zonedParts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const parts = getTzFmt(tz).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const h = get("hour");
  const mi = get("minute");
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 = Sunday
  return { y, mo, d, h, mi, dow };
}

/** Convert a wall-clock datetime in `tz` to UTC epoch ms (DST-aware via offset refinement) */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, tz);
    const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess = target - (wall - guess); // u_{n+1} = W - offset(u_n)
  }
  return guess;
}

/** Next occurrence of HH:MM in `tz` after fromMs */
function nextTimeInTz(hh: number, mm: number, tz: string, fromMs: number): number {
  const now = zonedParts(fromMs, tz);
  let t = zonedToUtc(now.y, now.mo, now.d, hh, mm, tz);
  if (t <= fromMs) t = zonedToUtc(now.y, now.mo, now.d + 1, hh, mm, tz);
  return t;
}

interface CronExpr {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

function parseCronField(field: string, min: number, max: number): { values: Set<number>; isStar: boolean } {
  const values = new Set<number>();
  let isStar = false;
  for (const raw of field.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (part === "*") {
      isStar = true;
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }
    const starStep = part.match(/^\*\/(\d+)$/);
    if (starStep) {
      isStar = true;
      const step = Number(starStep[1]) || 1;
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }
    const m = part.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    const step = m[3] ? Number(m[3]) : 1;
    if (start < min || end > max || start > end) continue;
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return { values, isStar };
}

/** Parse a 5-field cron expression: minute hour dom month dow (dow: 0/7 = Sunday) */
export function parseCron(expr: string): CronExpr | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dowRaw = parseCronField(parts[4], 0, 7);
  if (minute.values.size === 0 || hour.values.size === 0 || dom.values.size === 0 || month.values.size === 0 || dowRaw.values.size === 0) return null;
  const dow = new Set<number>();
  for (const v of dowRaw.values) dow.add(v === 7 ? 0 : v);
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow,
    domStar: dom.isStar,
    dowStar: dowRaw.isStar,
  };
}

/** Next UTC epoch ms matching `expr` in `tz` after fromMs */
export function nextRunFromCron(expr: string, fromMs: number, tz: string): number {
  const c = parseCron(expr);
  if (!c) return fromMs + 24 * 3600 * 1000;
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  const guard = 366 * 24 * 60;
  for (let i = 0; i < guard; i++) {
    const p = zonedParts(t, tz);
    if (!c.month.has(p.mo)) {
      t = zonedToUtc(p.y, p.mo + 1, 1, 0, 0, tz);
      continue;
    }
    // dom/dow: standard cron semantics — if both restricted, match EITHER; if one is *, match the other
    const dayOk = c.domStar ? c.dow.has(p.dow) : c.dowStar ? c.dom.has(p.d) : c.dom.has(p.d) || c.dow.has(p.dow);
    if (!dayOk) {
      t = zonedToUtc(p.y, p.mo, p.d + 1, 0, 0, tz);
      continue;
    }
    if (!c.hour.has(p.h)) {
      t = zonedToUtc(p.y, p.mo, p.d, p.h + 1, 0, tz);
      continue;
    }
    if (!c.minute.has(p.mi)) {
      t += 60000;
      continue;
    }
    return t;
  }
  return fromMs + 24 * 3600 * 1000;
}

// ===================== Jobs (recurring reminders + keyword alerts) =====================

interface Schedule {
  kind: "cron" | "interval";
  expr?: string;
  minutes?: number;
  tz: string;
}

export interface JobRow {
  id: string;
  chat_id: string;
  type: string;
  schedule: string;
  message?: string | null;
  keyword?: string | null;
  next_run: number;
  last_run?: number | null;
  last_result?: string | null;
  enabled?: number;
}

const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** Map natural-language frequency args → machine schedule */
export function buildSchedule(
  frequency: string,
  time?: string,
  dayOfWeek?: string,
  intervalHours?: number,
  cronExpr?: string,
  timezone?: string
): Schedule | null {
  const tz = timezone && isValidTz(timezone) ? timezone : "UTC";
  let h = 9;
  let m = 0;
  if (time && /^\d{1,2}:\d{2}$/.test(time)) {
    const [hh, mm] = time.split(":").map(Number);
    if (hh > 23 || mm > 59) return null;
    h = hh;
    m = mm;
  }
  switch ((frequency || "").toLowerCase()) {
    case "daily":
      return { kind: "cron", expr: `${m} ${h} * * *`, tz };
    case "weekly": {
      const dow = dayOfWeek ? DAY_INDEX[dayOfWeek.toLowerCase()] : 1;
      if (dow === undefined) return null;
      return { kind: "cron", expr: `${m} ${h} * * ${dow}`, tz };
    }
    case "weekdays":
      return { kind: "cron", expr: `${m} ${h} * * 1-5`, tz };
    case "weekends":
      return { kind: "cron", expr: `${m} ${h} * * 0,6`, tz };
    case "hourly": {
      const mins = Math.max(1, Math.floor(intervalHours ?? 1) * 60);
      return { kind: "interval", minutes: mins, tz };
    }
    case "custom": {
      if (!cronExpr || !parseCron(cronExpr)) return null;
      return { kind: "cron", expr: cronExpr, tz };
    }
    default:
      return null;
  }
}

/** Compute the next UTC run time for a stored schedule JSON */
export function computeJobNextRun(scheduleJson: string, fromMs: number): number {
  try {
    const s: Schedule = JSON.parse(scheduleJson);
    if (s.kind === "interval") {
      return fromMs + Math.max(1, s.minutes ?? 60) * 60000;
    }
    if (s.kind === "cron" && s.expr) {
      const next = nextRunFromCron(s.expr, fromMs, s.tz || "UTC");
      return next > fromMs ? next : fromMs + 60000;
    }
  } catch {}
  return fromMs + 24 * 3600 * 1000;
}

export async function createJob(
  db: D1Database,
  chatId: string,
  type: string,
  schedule: Schedule,
  payload: { message?: string; keyword?: string }
): Promise<{ id: string; next_run: number } | null> {
  const id = crypto.randomUUID().slice(0, 8);
  const next_run = computeJobNextRun(JSON.stringify(schedule), Date.now());
  await db
    .prepare(
      "INSERT INTO jobs (id, chat_id, type, schedule, message, keyword, next_run, last_run, last_result, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1)"
    )
    .bind(id, chatId, type, JSON.stringify(schedule), payload.message ?? null, payload.keyword ?? null, next_run)
    .run();
  return { id, next_run };
}

export async function listJobs(db: D1Database, chatId: string): Promise<JobRow[]> {
  const results = await db
    .prepare("SELECT id, type, schedule, message, keyword, next_run, enabled FROM jobs WHERE chat_id = ? AND enabled = 1 ORDER BY next_run ASC")
    .bind(chatId)
    .all<JobRow>();
  return results.results || [];
}

export async function cancelJob(db: D1Database, chatId: string, jobId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM jobs WHERE id = ? AND chat_id = ?").bind(jobId, chatId).run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Execute a due job (called by the worker cron). Sends the Telegram payload and
 * updates keyword dedup state. Throws on send failure so the tick can log it.
 */
export async function runScheduledJob(env: Env, job: JobRow): Promise<void> {
  if (job.type === "reminder") {
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: job.chat_id,
        text: `<b>⏰ Recurring reminder:</b> ${escapeHtml((job.message || "").slice(0, 200))}`,
        parse_mode: "HTML",
      }),
    });
    if (!resp.ok) throw new Error(`Telegram send failed: ${resp.status}`);
    console.log(`[JOB] reminder ${job.id} delivered to ${job.chat_id}`);
    return;
  }
  if (job.type === "keyword") {
    if (!env.TAVILY_API_KEY) {
      console.warn("[JOB] keyword alert skipped: no TAVILY_API_KEY");
      return;
    }
    const keyword = job.keyword || "";
    const result = await searchWeb(env.TAVILY_API_KEY, keyword);
    // Track seen URLs so the user only hears about NEW results
    const urls = [...result.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map((mm) => mm[2]);
    let seen: string[] = [];
    try {
      seen = JSON.parse(job.last_result || "{}").urls || [];
    } catch {}
    if (urls.length === 0 || urls.some((u) => !seen.includes(u))) {
      const body = mdToTelegramHtml(result);
      const text = `<b>🔔 Keyword alert:</b> <i>${escapeHtml(keyword)}</i>\n\n${body}`;
      const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: job.chat_id, text: text.slice(0, 4096), parse_mode: "HTML" }),
      });
      if (!resp.ok) throw new Error(`Telegram send failed: ${resp.status}`);
      console.log(`[JOB] keyword alert ${job.id} sent to ${job.chat_id} (${urls.length} urls)`);
    } else {
      console.log(`[JOB] keyword alert ${job.id}: no new results (seen ${seen.length} urls)`);
    }
    await env.IVY_DB.prepare("UPDATE jobs SET last_result = ? WHERE id = ?").bind(JSON.stringify({ urls }), job.id).run();
    return;
  }
  if (job.type === "pagewatch") {
    // unread-watch style: fetch the URL, fingerprint the content, alert on change
    const url = job.message || job.keyword || "";
    if (!url) throw new Error("pagewatch job missing url");
    const res = await fetchUrlContent(url);
    if (!res.ok || !res.text || !res.hash) {
      console.warn(`[JOB] pagewatch ${job.id}: fetch failed (${res.error || res.status})`);
      await env.IVY_DB.prepare("UPDATE jobs SET last_result = ? WHERE id = ?")
        .bind(JSON.stringify({ url, ok: false, status: res.status, error: res.error, fetchedAt: res.fetchedAt }), job.id)
        .run();
      return;
    }
    let prev: { hash?: string } = {};
    try {
      prev = JSON.parse(job.last_result || "{}");
    } catch {}
    await env.IVY_DB.prepare("UPDATE jobs SET last_result = ? WHERE id = ?")
      .bind(JSON.stringify({ url, ok: true, status: res.status, hash: res.hash, fetchedAt: res.fetchedAt, chars: res.chars }), job.id)
      .run();
    const label = res.title || url;
    if (!prev.hash) {
      // First run — establish baseline and confirm the watch is active
      const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: job.chat_id,
          text: `👀 Watching <a href="${escapeHtml(url)}">${escapeHtml(label)}</a> (${res.chars} chars) — I'll notify you when the page changes.`,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: false, show_above_text: true },
        }),
      });
      if (!resp.ok) throw new Error(`Telegram send failed: ${resp.status}`);
      console.log(`[JOB] pagewatch ${job.id}: baseline set for ${url}`);
      return;
    }
    if (prev.hash !== res.hash) {
      const snippet = (res.text || "").slice(0, 900).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
      const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: job.chat_id,
          text:
            `🔔 <b>Page changed:</b> <a href="${escapeHtml(url)}">${escapeHtml(label)}</a>\n\n` +
            `<i>Preview:</i>\n${escapeHtml(snippet)}…`,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: false, show_above_text: true },
        }),
      });
      if (!resp.ok) throw new Error(`Telegram send failed: ${resp.status}`);
      console.log(`[JOB] pagewatch ${job.id}: change detected on ${url}`);
    } else {
      console.log(`[JOB] pagewatch ${job.id}: no change (hash ${res.hash})`);
    }
    return;
  }
  throw new Error(`Unknown job type: ${job.type}`);
}

// ===================== Weather (Open-Meteo, free, no key) =====================

const WMO_CODES: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

/** Legacy/alternate city names → official names understood by Open-Meteo geocoding */
const CITY_ALIASES: Record<string, string> = {
  bangalore: "Bengaluru",
  bangaluru: "Bengaluru",
  bombay: "Mumbai",
  calcutta: "Kolkata",
  madras: "Chennai",
  newdelhi: "New Delhi",
  delhi: "New Delhi",
};

export async function getWeather(city: string): Promise<string> {
  try {
    const key = city.trim().toLowerCase().replace(/\s+/g, "");
    const searchName = CITY_ALIASES[key] ?? city.trim();
    const geoResp = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchName)}&count=10&language=en&format=json`
    );
    if (!geoResp.ok) return `Weather lookup failed (${geoResp.status}).`;
    const geo: any = await geoResp.json();
    // Prefer the largest populated place (handles ambiguous names like "Bangalore")
    const results: any[] = (geo.results || []).slice().sort((a: any, b: any) => (b.population || 0) - (a.population || 0));
    const loc = results[0];
    if (!loc) return `Couldn't find a place called "${city}". Try a larger city name.`;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=2`;
    const wResp = await fetch(url);
    if (!wResp.ok) return `Weather API error (${wResp.status}).`;
    const w: any = await wResp.json();
    const cur = w.current || {};
    const desc = WMO_CODES[cur.weather_code] ?? `Code ${cur.weather_code}`;
    const tMax = w.daily?.temperature_2m_max?.[0];
    const tMin = w.daily?.temperature_2m_min?.[0];
    const time = cur.time ? ` at ${cur.time.slice(11)}` : "";
    return (
      `🌤️ **Weather in ${loc.name}${loc.country ? ", " + loc.country : ""}**${time}:\n` +
      `• ${desc}\n` +
      `• Temperature: ${cur.temperature_2m ?? "?"}°C (feels like ${cur.apparent_temperature ?? "?"}°C)\n` +
      `• Humidity: ${cur.relative_humidity_2m ?? "?"}%\n` +
      `• Wind: ${cur.wind_speed_10m ?? "?"} km/h\n` +
      `• Today: ${tMin ?? "?"}°C min / ${tMax ?? "?"}°C max`
    );
  } catch (e: any) {
    return `Weather error: ${e.message}`;
  }
}

// ===================== YouTube Transcript =====================

function extractYouTubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

const INNERTUBE_CLIENTS = [
  { clientName: "IOS", clientVersion: "20.12.54" },
  { clientName: "ANDROID", clientVersion: "20.12.54", androidSdkVersion: 30 },
];

async function fetchYouTubePlayerResponse(videoId: string): Promise<any | null> {
  // Innertube player API (public web key used by YouTube's own web client) — no cookies needed
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const resp = await fetch("https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, context: { client } }),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        if (data?.captions?.playerCaptionsTracklistRenderer?.captionTracks) return data;
      }
    } catch {}
  }
  // Fallback: scrape the watch page for ytInitialPlayerResponse
  try {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { "Accept-Language": "en" } })).text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});\s*(?:var\s|<\/script|$)/s);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {}
    }
  } catch {}
  return null;
}

export async function getYoutubeTranscript(url: string): Promise<string> {
  const videoId = extractYouTubeId(url);
  if (!videoId) return "Could not extract a YouTube video ID from that URL.";
  const player = await fetchYouTubePlayerResponse(videoId);
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return `No captions available for this video${player?.videoDetails?.title ? ` ("${player.videoDetails.title}")` : ""}. The uploader may have captions disabled.`;
  }
  // Prefer manual English captions, then any non-ASR track
  const rank = (t: any) => (t.languageCode?.startsWith("en") ? 0 : 1) + (t.kind === "asr" ? 2 : 0);
  const track = [...tracks].sort((a, b) => rank(a) - rank(b))[0];
  const tResp = await fetch(`${track.baseUrl}&fmt=json3`);
  if (!tResp.ok) return `Failed to fetch captions (${tResp.status}).`;
  const data: any = await tResp.json();
  const events: any[] = data.events || [];
  let text = "";
  for (const ev of events) {
    const segs = ev.segs || [];
    for (const seg of segs) text += seg.utf8 ?? "";
    if (segs.length) text += "\n";
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return "Captions exist but the transcript is empty.";
  const title = player?.videoDetails?.title;
  return (
    `Video: ${title ?? videoId} (${track.languageCode ?? "?"}, ${track.kind === "asr" ? "auto-generated" : "manual"} captions)\n\n` +
    `${text.slice(0, 20000)}${text.length > 20000 ? "\n\n[truncated]" : ""}`
  );
}

// ===================== Movie Tools =====================

const TMDB_BASE = "https://api.themoviedb.org/3";

interface MovieResult {
  id: number;
  title: string;
  release_date?: string;
  vote_average?: number;
  overview?: string;
  poster_path?: string;
  genre_ids?: number[];
}

const GENRE_MAP: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
  80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
  14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 10770: "TV Movie",
  53: "Thriller", 10752: "War", 37: "Western",
};

function formatMovieList(movies: MovieResult[], prefix: string): string {
  if (!movies.length) return "No movies found.";
  return movies
    .map((m, i) => {
      const year = m.release_date ? `(${m.release_date.slice(0, 4)})` : "";
      const rating = m.vote_average ? ` ⭐ ${m.vote_average.toFixed(1)}` : "";
      const genres = m.genre_ids
        ? m.genre_ids.map((g) => GENRE_MAP[g]).filter(Boolean).join(", ")
        : "";
      const genreStr = genres ? ` [${genres}]` : "";
      return `${prefix} ${i + 1}. **${m.title}** ${year}${rating}${genreStr}`;
    })
    .join("\n");
}

async function tmdbFetch(apiKey: string, path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString());
  if (!resp.ok) return null;
  return resp.json();
}

async function searchMoviesTmdb(apiKey: string, query: string, year?: string): Promise<string> {
  const data = await tmdbFetch(apiKey, "/search/movie", { query, year: year || "", include_adult: "false" });
  if (!data?.results?.length) return "No movies found.";
  return formatMovieList(data.results.slice(0, 8), "🎬");
}

async function getRecommendationsTmdb(apiKey: string, title: string): Promise<string> {
  // Search for the movie first
  const search = await tmdbFetch(apiKey, "/search/movie", { query: title, include_adult: "false" });
  if (!search?.results?.length) return `Could not find "${title}".`;
  const movieId = search.results[0].id;
  const movieName = search.results[0].title;

  const data = await tmdbFetch(apiKey, `/movie/${movieId}/recommendations`);
  if (!data?.results?.length) return `No recommendations found for "${movieName}".`;
  let out = `🎯 *Because you liked ${movieName}:*\n\n`;
  out += formatMovieList(data.results.slice(0, 8), "→");
  return out;
}

async function discoverMoviesTmdb(
  apiKey: string,
  genres?: string,
  minRating?: string,
  year?: string
): Promise<string> {
  const genreMap: Record<string, string> = {};
  for (const [id, name] of Object.entries(GENRE_MAP)) {
    genreMap[name.toLowerCase()] = id;
  }

  let genreIds: string[] = [];
  if (genres) {
    genreIds = genres
      .split(",")
      .map((g) => genreMap[g.trim().toLowerCase()])
      .filter(Boolean) as string[];
  }

  const params: Record<string, string> = {
    sort_by: "vote_average.desc",
    "vote_count.gte": "100",
    include_adult: "false",
  };
  if (genreIds.length) params.with_genres = genreIds.join(",");
  if (minRating) params["vote_average.gte"] = minRating;
  if (year) params.year = year;

  const data = await tmdbFetch(apiKey, "/discover/movie", params);
  if (!data?.results?.length) return "No movies found matching those criteria.";
  let out = "🎬 *Recommended Movies:*\n\n";
  out += formatMovieList(data.results.slice(0, 8), "→");
  return out;
}

// ===================== Reddit API =====================

const REDDIT_AUTH = "https://www.reddit.com/api/v1";
const REDDIT_OAUTH = "https://oauth.reddit.com";

interface RedditToken {
  access_token: string;
  expires_in: number;
  token_type: string;
}

async function getRedditToken(clientId: string, clientSecret: string, userAgent: string): Promise<string | null> {
  const resp = await fetch(`${REDDIT_AUTH}/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) return null;
  const data: RedditToken = await resp.json();
  return data.access_token;
}

async function redditGet(
  clientId: string,
  clientSecret: string,
  userAgent: string,
  path: string,
  params: Record<string, string> = {}
): Promise<any | null> {
  const token = await getRedditToken(clientId, clientSecret, userAgent);
  if (!token) return null;
  const url = new URL(`${REDDIT_OAUTH}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent,
    },
  });
  if (!resp.ok) return null;
  return resp.json();
}

function formatRedditPosts(data: any, maxPosts = 8): string {
  const children = data?.data?.children;
  if (!children?.length) return "";
  return children
    .slice(0, maxPosts)
    .map((c: any) => {
      const d = c.data;
      const title = d.title || "";
      const sub = d.subreddit ? `r/${d.subreddit}` : "";
      const score = d.ups ? `👍 ${d.ups}` : "";
      const url = d.permalink
        ? `https://old.reddit.com${d.permalink}`
        : d.url || "";
      const self = d.selftext ? (d.selftext.length > 200 ? d.selftext.slice(0, 200) + "…" : d.selftext) : "";
      return `- **${title}** (${sub}, ${score})\n  ${url}${self ? `\n  > ${self.replace(/\n/g, " ")}` : ""}`;
    })
    .join("\n\n");
}

async function redditMovieInfo(
  clientId: string,
  clientSecret: string,
  userAgent: string,
  title: string
): Promise<string | null> {
  // Search r/movies and r/moviecritic for the specific movie
  let out = "";
  for (const sub of ["movies", "moviecritic", "TrueFilm"]) {
    const data = await redditGet(clientId, clientSecret, userAgent, `/r/${sub}/search.json`, {
      q: title,
      restrict_sr: "1",
      sort: "relevance",
      limit: "3",
    });
    if (data) {
      const posts = formatRedditPosts(data, 3);
      if (posts) {
        out += `### r/${sub} discussions:\n${posts}\n\n`;
      }
    }
  }
  return out || null;
}

async function redditMovieRecs(
  clientId: string,
  clientSecret: string,
  userAgent: string,
  preferences: string
): Promise<string | null> {
  let out = "";
  // Primary: r/MovieSuggestions
  const subs = ["MovieSuggestions", "movies", "ifyoulikeblank"];
  for (const sub of subs) {
    const queries = preferences
      ? [
          `"similar to" ${preferences}`,
          `recommendations like ${preferences}`,
          `movies like ${preferences}`,
        ]
      : ["underrated movies", "best movies 2025", "movies you enjoyed"];

    for (const q of queries) {
      const data = await redditGet(clientId, clientSecret, userAgent, `/r/${sub}/search.json`, {
        q,
        restrict_sr: "1",
        sort: "top",
        limit: "3",
      });
      if (data) {
        const posts = formatRedditPosts(data, 3);
        if (posts) {
          out += `### r/${sub} — "${q}":\n${posts}\n\n`;
          break; // One good query per subreddit is enough
        }
      }
    }
  }

  // Also get hot/rising from MovieSuggestions for general recs
  if (!out) {
    const hot = await redditGet(clientId, clientSecret, userAgent, "/r/MovieSuggestions/hot.json", { limit: "5" });
    if (hot) {
      const posts = formatRedditPosts(hot, 5);
      if (posts) out += `### r/MovieSuggestions (hot):\n${posts}\n\n`;
    }
  }

  return out || null;
}

async function redditDiscoverMovies(
  clientId: string,
  clientSecret: string,
  userAgent: string,
  genres?: string,
  year?: string
): Promise<string | null> {
  let out = "";
  const subs = ["movies", "MovieSuggestions"];
  const qParts: string[] = [];
  if (genres) qParts.push(`"${genres}"`);
  if (year) qParts.push(year);
  qParts.push("recommendations");
  const query = qParts.join(" ");

  for (const sub of subs) {
    const data = await redditGet(clientId, clientSecret, userAgent, `/r/${sub}/search.json`, {
      q: query,
      restrict_sr: "1",
      sort: "top",
      limit: "5",
      t: "year",
    });
    if (data) {
      const posts = formatRedditPosts(data, 5);
      if (posts) {
        out += `### r/${sub}:\n${posts}\n\n`;
      }
    }
  }

  return out || null;
}

// ===================== Tavily with Reddit targeting =====================

async function tavilySearch(apiKey: string, query: string): Promise<string | null> {
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
  if (!resp.ok) return null;
  const data: any = await resp.json();
  if (!data.results?.length) return null;
  let out = data.answer ? `**Summary:** ${data.answer}\n\n` : "";
  out += data.results
    .map((r: any, i: number) => `${i + 1}. [${r.title}](${r.url}) — ${(r.content || "").slice(0, 300)}`)
    .join("\n\n");
  return out;
}

async function movieInfoTavily(apiKey: string, title: string): Promise<string> {
  const redditQuery = `site:reddit.com ${title} movie review discussion r/movies r/moviecritic`;
  const redditResult = await tavilySearch(apiKey, redditQuery);
  if (redditResult) return `🗣️ *What Reddit says about "${title}":*\n\n${redditResult}`;

  // Fallback: general search
  const generalResult = await tavilySearch(apiKey, `${title} movie rating cast review 2024 2025`);
  if (generalResult) return generalResult;
  return "No information found.";
}

async function movieRecsTavily(apiKey: string, preferences: string): Promise<string> {
  // First try: Reddit-specific
  const redditQuery = preferences
    ? `site:reddit.com r/MovieSuggestions OR r/ifyoulikeblank OR r/movies movies like similar to ${preferences} recommendations`
    : "site:reddit.com r/MovieSuggestions best underrated movies reddit recommends";
  const redditResult = await tavilySearch(apiKey, redditQuery);
  if (redditResult) return `🗣️ *Reddit recommendations:*\n\n${redditResult}`;

  // Fallback: general
  const generalQuery = preferences
    ? `best movies similar to ${preferences} trending 2024 2025 2026`
    : "best movies to watch right now trending popular critics choice";
  const generalResult = await tavilySearch(apiKey, generalQuery);
  if (generalResult) return generalResult;
  return "No recommendations found.";
}

async function discoverTavily(apiKey: string, genres?: string, year?: string, minRating?: string): Promise<string> {
  const qParts: string[] = ["site:reddit.com r/movies OR r/MovieSuggestions"];
  if (genres) qParts.push(genres);
  if (year) qParts.push(year);
  if (minRating) qParts.push(`rated ${minRating}/10`);
  qParts.push("recommendations best");
  const redditResult = await tavilySearch(apiKey, qParts.join(" "));
  if (redditResult) return `🗣️ *What Reddit recommends:*\n\n${redditResult}`;

  // General fallback
  const gParts: string[] = [];
  if (genres) gParts.push(genres);
  if (year) gParts.push(year);
  gParts.push("movies best rated");
  if (minRating) gParts.push(minRating);
  const generalResult = await tavilySearch(apiKey, gParts.join(" "));
  if (generalResult) return generalResult;
  return "No movies found matching those criteria.";
}

// ===================== Reminder Tools =====================

async function createReminder(db: D1Database, chatId: string, timeStr: string, message: string, timezone?: string) {
  let timestamp: number;
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [h, m] = timeStr.split(":").map(Number);
    if (h > 23 || m > 59) return null;
    if (timezone && isValidTz(timezone)) {
      // Timezone-aware: interpret HH:MM in the user's timezone
      timestamp = nextTimeInTz(h, m, timezone, Date.now());
    } else {
      const now = new Date();
      const t = new Date(now);
      t.setUTCHours(h, m, 0, 0);
      if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
      timestamp = t.getTime();
    }
  } else {
    timestamp = new Date(timeStr).getTime();
    if (isNaN(timestamp)) return null;
  }
  const id = crypto.randomUUID().slice(0, 8);
  await db.prepare("INSERT INTO reminders (id, chat_id, timestamp, message) VALUES (?, ?, ?, ?)").bind(id, chatId, timestamp, message).run();
  return { id, timestamp };
}

async function listReminders(db: D1Database, chatId: string) {
  const results = await db.prepare("SELECT id, timestamp, message FROM reminders WHERE chat_id = ? ORDER BY timestamp ASC").bind(chatId).all<{ id: string; timestamp: number; message: string }>();
  return results.results || [];
}

async function cancelReminder(db: D1Database, chatId: string, reminderId: string) {
  const result = await db.prepare("DELETE FROM reminders WHERE id = ? AND chat_id = ?").bind(reminderId, chatId).run();
  return (result.meta.changes ?? 0) > 0;
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
        description: "Schedule a one-time reminder at a specific time. Call this when the user asks to be reminded or notified once.",
        parameters: {
          type: "object",
          properties: {
            time: { type: "string", description: "Time in HH:MM (24-hour) format, or an ISO date string" },
            message: { type: "string", description: "The reminder message" },
            timezone: { type: "string", description: "Optional IANA timezone (e.g. 'Asia/Kolkata') to interpret HH:MM in. Defaults to UTC." },
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
        name: "kg_add_fact",
        description: "Save a structured fact (subject → predicate → object) to the knowledge graph. Use for relationships, preferences, and evolving knowledge the user may ask about later — e.g. subject='Alex', predicate='favorite director', object='Christopher Nolan'. Use memory_save for simple one-off facts instead.",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", description: "The thing the fact is about (person, topic, project, etc.)" },
            predicate: { type: "string", description: "The relationship or attribute, e.g. 'lives in', 'works on', 'favorite'" },
            object: { type: "string", description: "The value, e.g. 'Bangalore', 'a robotics startup', 'Christopher Nolan'" },
          },
          required: ["subject", "predicate", "object"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "kg_query",
        description: "Query the knowledge graph for structured facts about a subject (person, topic, project, etc.). Use when the user asks what you know about someone or something.",
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string", description: "Subject to look up. Omit to list the most recent facts." },
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
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather and today's forecast for a city. Use when the user asks about weather, temperature, rain, or forecast.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name, e.g. 'Bangalore' or 'London'" },
          },
          required: ["city"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_youtube_transcript",
        description: "Get the transcript (captions) of a YouTube video. Use when the user asks to summarize a YouTube video or wants its transcript or key points.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The YouTube video URL or ID" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_recurring_reminder",
        description: "Create a recurring job that fires repeatedly — daily, weekly, weekdays, weekends, every N hours, or a custom cron expression. Use when the user says things like 'remind me every day at 8am to drink water', 'every Monday at 9am', 'every 2 hours'. Supports timezone-aware scheduling.",
        parameters: {
          type: "object",
          properties: {
            frequency: { type: "string", enum: ["daily", "weekly", "weekdays", "weekends", "hourly", "custom"], description: "How often the job runs" },
            time: { type: "string", description: "Time of day in HH:MM (24-hour) for daily/weekly/weekdays/weekends" },
            day_of_week: { type: "string", description: "Day name (e.g. 'monday') required for frequency=weekly" },
            interval_hours: { type: "number", description: "Hours between runs for frequency=hourly (default 1)" },
            cron_expr: { type: "string", description: "5-field cron expression for frequency=custom, e.g. '0 8 * * *' or '*/30 * * * *'" },
            message: { type: "string", description: "The reminder message" },
            timezone: { type: "string", description: "Optional IANA timezone like 'Asia/Kolkata' or 'America/New_York' (default UTC)" },
          },
          required: ["frequency", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_keyword_alert",
        description: "Create a recurring keyword alert that searches the web and notifies the user when there are NEW results. Use when the user says 'notify me when X happens', 'alert me about X', 'watch for X', 'keep an eye on X'.",
        parameters: {
          type: "object",
          properties: {
            keyword: { type: "string", description: "The search keyword or phrase to watch" },
            frequency: { type: "string", enum: ["daily", "hourly", "weekly", "custom"], description: "How often to check (default daily)" },
            time: { type: "string", description: "Time of day HH:MM (24-hour) for daily/weekly" },
            cron_expr: { type: "string", description: "5-field cron expression for frequency=custom" },
            timezone: { type: "string", description: "Optional IANA timezone (default UTC)" },
          },
          required: ["keyword"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_jobs",
        description: "List all active recurring jobs (recurring reminders and keyword alerts) with their next run time.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "cancel_job",
        description: "Cancel/delete a recurring job (recurring reminder or keyword alert) by its ID.",
        parameters: {
          type: "object",
          properties: {
            job_id: { type: "string", description: "The job ID to cancel" },
          },
          required: ["job_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "check_url",
        description: "Quickly check whether a URL is live/reachable and get its HTTP status and page title. Use when the user asks 'is this page live', 'is the site down/up', or 'did the page load'.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to check" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "watch_page",
        description: "Watch a web page and notify the user whenever its content changes. Use when the user says 'watch this page', 'notify me when this page changes', 'check this page for updates', 'track this page', or wants to monitor a URL for changes/notifications.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL of the page to watch" },
            label: { type: "string", description: "Optional friendly label for the watch" },
            frequency: { type: "string", enum: ["hourly", "daily", "weekly", "custom"], description: "How often to check (default daily)" },
            time: { type: "string", description: "Time of day HH:MM for daily/weekly checks" },
            cron_expr: { type: "string", description: "5-field cron expression for frequency=custom" },
            timezone: { type: "string", description: "Optional IANA timezone (default UTC)" },
          },
          required: ["url"],
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

  // Movie tools — TMDB → Reddit → Tavily with Reddit targeting
  const hasMovieTools = !!(env.TMDB_API_KEY || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) || env.TAVILY_API_KEY);
  if (hasMovieTools) {
    tools.push({
      type: "function",
      function: {
        name: "get_movie_info",
        description: "Get detailed information about a movie including rating, cast overview, release year. Use this when the user asks about a specific movie.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "The movie title" },
            year: { type: "string", description: "Optional release year" },
          },
          required: ["title"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "get_movie_recommendations",
        description: "Get movie recommendations similar to a given movie title. Use this when the user wants suggestions based on a movie they liked.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "A movie title the user enjoyed" },
          },
          required: ["title"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "discover_movies",
        description: "Discover movies by genre, minimum rating, or year. Use this when the user wants to find movies to watch based on preferences like 'action movies from 2024'.",
        parameters: {
          type: "object",
          properties: {
            genres: { type: "string", description: "Comma-separated genres like 'Action, Sci-Fi, Comedy'" },
            min_rating: { type: "string", description: "Minimum rating (0-10) like '7'" },
            year: { type: "string", description: "Release year like '2024'" },
          },
        },
      },
    });
  }

  return tools;
}

// ===================== Function Call Dispatcher =====================

async function handleFunctionCall(env: Env, chatId: string, toolCall: GroqToolCall): Promise<string> {
  // Never let malformed/empty tool arguments crash the whole reply.
  let args: any = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    args = {};
  }
  if (typeof args !== "object" || args === null) args = {};
  switch (toolCall.function.name) {
    case "create_reminder": {
      const result = await createReminder(env.IVY_DB, chatId, args.time, args.message, args.timezone);
      if (!result) return "Could not parse that time. Please use HH:MM format.";
      return JSON.stringify({
        status: "created",
        id: result.id,
        timestamp: result.timestamp,
        display: `<t:${Math.floor(result.timestamp / 1000)}:f>`,
        message: args.message,
      });
    }
    case "create_recurring_reminder": {
      const schedule = buildSchedule(args.frequency, args.time, args.day_of_week, args.interval_hours, args.cron_expr, args.timezone);
      if (!schedule) {
        return JSON.stringify({ status: "error", message: "Could not parse that schedule. Use frequency daily/weekly/weekdays/weekends/hourly/custom with time HH:MM." });
      }
      const job = await createJob(env.IVY_DB, chatId, "reminder", schedule, { message: args.message });
      if (!job) return JSON.stringify({ status: "error" });
      return JSON.stringify({
        status: "created",
        id: job.id,
        type: "recurring reminder",
        schedule: schedule,
        next_run: job.next_run,
        display: `<t:${Math.floor(job.next_run / 1000)}:f>`,
      });
    }
    case "create_keyword_alert": {
      const schedule = buildSchedule(args.frequency || "daily", args.time, undefined, undefined, args.cron_expr, args.timezone);
      if (!schedule) return JSON.stringify({ status: "error", message: "Could not parse that schedule." });
      const job = await createJob(env.IVY_DB, chatId, "keyword", schedule, { keyword: args.keyword });
      if (!job) return JSON.stringify({ status: "error" });
      return JSON.stringify({
        status: "created",
        id: job.id,
        type: "keyword alert",
        keyword: args.keyword,
        schedule: schedule,
        next_run: job.next_run,
        display: `<t:${Math.floor(job.next_run / 1000)}:f>`,
      });
    }
    case "list_jobs": {
      const items = await listJobs(env.IVY_DB, chatId);
      return JSON.stringify(
        items.map((j) => ({
          id: j.id,
          type: j.type,
          message: j.message || j.keyword || "",
          schedule: j.schedule,
          next_run: j.next_run,
          display: `<t:${Math.floor(j.next_run / 1000)}:R>`,
        }))
      );
    }
    case "cancel_job": {
      const ok = await cancelJob(env.IVY_DB, chatId, args.job_id);
      return JSON.stringify({ status: ok ? "cancelled" : "not_found" });
    }
    case "check_url": {
      const r = await fetchUrlContent(args.url);
      if (!r.ok) return JSON.stringify({ status: "down", error: r.error, url: r.url, checked_at: r.fetchedAt });
      return JSON.stringify({
        status: "live",
        http: r.status,
        title: r.title || null,
        chars: r.chars || 0,
        hash: r.hash,
        url: r.url,
        checked_at: r.fetchedAt,
      });
    }
    case "watch_page": {
      const schedule = buildSchedule(args.frequency || "daily", args.time, undefined, undefined, args.cron_expr, args.timezone);
      if (!schedule) return JSON.stringify({ status: "error", message: "Could not parse that schedule." });
      const job = await createJob(env.IVY_DB, chatId, "pagewatch", schedule, { message: args.url, keyword: args.label });
      if (!job) return JSON.stringify({ status: "error" });
      return JSON.stringify({
        status: "created",
        id: job.id,
        type: "page watch",
        url: args.url,
        schedule: schedule,
        next_run: job.next_run,
        display: `<t:${Math.floor(job.next_run / 1000)}:f>`,
      });
    }
    case "list_reminders": {
      const items = await listReminders(env.IVY_DB, chatId);
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
      const ok = await cancelReminder(env.IVY_DB, chatId, args.reminder_id);
      return JSON.stringify({ status: ok ? "cancelled" : "not_found" });
    }
    case "search_web":
      return await searchWeb(env.TAVILY_API_KEY!, args.query);
    case "memory_save":
      return await memorySave(env.IVY_DB, chatId, args.key, args.value);
    case "memory_recall":
      return await memoryRecall(env.IVY_DB, chatId, args.key);
    case "kg_add_fact":
      return await kgAddFact(env.IVY_DB, chatId, args.subject, args.predicate, args.object);
    case "kg_query":
      return await kgQuery(env.IVY_DB, chatId, args.subject);
    case "fetch_url":
      return await fetchUrl(args.url);
    case "get_current_time":
      return getCurrentTime(args.timezone);
    case "get_weather":
      return await getWeather(args.city);
    case "get_youtube_transcript":
      return await getYoutubeTranscript(args.url);
    case "get_movie_info": {
      // TMDB → Reddit → Tavily (Reddit-targeted)
      if (env.TMDB_API_KEY) {
        const tmdbResult = await searchMoviesTmdb(env.TMDB_API_KEY, args.title, args.year);
        // Add Reddit flavor if available
        if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
          const redditInfo = await redditMovieInfo(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT, args.title);
          if (redditInfo) {
            return `${tmdbResult}\n\n---\n\n🗣️ *Reddit discussions:*\n${redditInfo}`;
          }
        }
        return tmdbResult;
      }
      if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
        const redditInfo = await redditMovieInfo(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT, args.title);
        if (redditInfo) return `🗣️ *Reddit discussions about "${args.title}":*\n\n${redditInfo}`;
      }
      if (env.TAVILY_API_KEY) return await movieInfoTavily(env.TAVILY_API_KEY, args.title);
      return "Movie search is not configured.";
    }
    case "get_movie_recommendations": {
      // TMDB → Reddit → Tavily (Reddit-targeted)
      if (env.TMDB_API_KEY) {
        const tmdbResult = await getRecommendationsTmdb(env.TMDB_API_KEY, args.title);
        // Add Reddit recs as bonus
        let combined = tmdbResult;
        if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
          const redditRecs = await redditMovieRecs(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT, args.title);
          if (redditRecs) {
            combined += `\n\n---\n\n🗣️ *What Reddit recommends:*\n${redditRecs}`;
          }
        }
        return combined;
      }
      if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
        const redditRecs = await redditMovieRecs(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT, args.title);
        if (redditRecs) return `🗣️ *Reddit recommendations for "${args.title}":*\n\n${redditRecs}`;
      }
      if (env.TAVILY_API_KEY) return await movieRecsTavily(env.TAVILY_API_KEY, args.title);
      return "Movie recommendations are not configured.";
    }
    case "discover_movies": {
      // TMDB → Reddit → Tavily (Reddit-targeted)
      if (env.TMDB_API_KEY) {
        const tmdbResult = await discoverMoviesTmdb(env.TMDB_API_KEY, args.genres, args.min_rating, args.year);
        let combined = tmdbResult;
        if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
          const redditDiscover = await redditDiscoverMovies(
            env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT,
            args.genres, args.year
          );
          if (redditDiscover) {
            combined += `\n\n---\n\n🗣️ *Reddit discussions:*\n${redditDiscover}`;
          }
        }
        return combined;
      }
      if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
        const redditDiscover = await redditDiscoverMovies(
          env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT,
          args.genres, args.year
        );
        if (redditDiscover) return `🗣️ *Reddit recommends:*\n\n${redditDiscover}`;
      }
      if (env.TAVILY_API_KEY) return await discoverTavily(env.TAVILY_API_KEY, args.genres, args.year, args.min_rating);
      return "Movie discovery is not configured.";
    }
    default:
      return `Unknown tool: ${toolCall.function.name}`;
  }
}

// ===================== Groq API Call =====================

const MODEL_MAX_TOKENS: Record<string, number> = {
  // Groq caps output at 8192 tokens — keep all Groq models at the limit
  "llama-3.3-70b-versatile": 8192,
  "llama-3.1-8b-instant": 8192,
  "openai/gpt-oss-20b": 8192,
  "openai/gpt-oss-120b": 8192,
};

// The platform terminates webhook requests after ~10s wall-clock (free plan).
// A 45s abort never fires on that path — a slow-but-alive model would kill the
// whole message instead of falling through the chain. Fast-fail at 8s so slow
// models (e.g. gemini-3.6-flash on free tier) hand off to the next model.
const MODEL_CALL_TIMEOUT_MS = 8000;

async function callGroq(
  apiKey: string,
  messages: ChatMessage[],
  tools: any[],
  model: string
): Promise<
  | { choices: Array<{ message: { content?: string; tool_calls?: GroqToolCall[] }; finish_reason: string }> }
  | { _rateLimited: true; model: string }
  | { _retry: true }
> {
  const maxTokens = MODEL_MAX_TOKENS[model] ?? 8192;
  const body: Record<string, any> = { model, messages, max_tokens: maxTokens, temperature: 0.7 };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_CALL_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${GROQ_API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timeout);
    // Timeout or network failure → try the next model in the chain
    console.warn(`[${model}] Groq request failed: ${e?.message || e.name}`);
    return { _rateLimited: true, model };
  }
  // Rate limits (429/413) AND server errors (5xx) → fall back to the next model
  if (resp.status === 429 || resp.status === 413 || resp.status >= 500) {
    clearTimeout(timeout);
    return { _rateLimited: true, model };
  }
  if (!resp.ok) {
    // Body read stays under the MODEL_CALL_TIMEOUT_MS abort signal (don't
    // clearTimeout early — a hung body read would otherwise hang the message).
    const err = await resp.text();
    clearTimeout(timeout);
    if (tools.length && resp.status === 400 && err.includes("tool_use_failed")) return { _retry: true };
    throw new Error(`Groq API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  try {
    const data: any = await resp.json();
    clearTimeout(timeout);
    return data;
  } catch (e: any) {
    clearTimeout(timeout);
    console.warn(`[${model}] Groq response read failed: ${e?.message || e.name}`);
    return { _rateLimited: true, model };
  }
}

// ===================== Gemini API Call =====================

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function convertContentToParts(content: string | any[] | undefined): any[] {
  if (!content) return [{ text: "" }];
  if (typeof content === "string") return [{ text: content }];
  const parts: any[] = [];
  for (const item of content) {
    if (item.type === "text") {
      parts.push({ text: item.text });
    } else if (item.type === "image_url") {
      const match = item.image_url.url.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      }
    }
  }
  return parts;
}

function messagesToGeminiContents(messages: ChatMessage[]): {
  contents: any[];
  systemInstruction?: any;
} {
  let systemInstruction: any;
  const contents: any[] = [];
  const callMap = new Map<string, string>();
  const replayedIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = { parts: [{ text: msg.content || "" }] };
      continue;
    }
    if (msg.role === "tool") {
      const fnName = msg.name || callMap.get(msg.tool_call_id || "") || msg.tool_call_id || "unknown";
      // Echo the functionCall id on the response so Gemini 3 models can map it back.
      const fr: any = { name: fnName, response: { result: msg.content } };
      if (msg.tool_call_id && replayedIds.has(msg.tool_call_id)) fr.id = msg.tool_call_id;
      contents.push({ role: "user", parts: [{ functionResponse: fr }] });
      continue;
    }
    if (msg.role === "assistant" && (msg as any).tool_calls?.length) {
      // Gemini REQUIRES the model's tool-call turn to be replayed as functionCall parts.
      // Replaying it as plain text (or empty) breaks the functionCall→functionResponse
      // pairing and corrupts the conversation on the next turn.
      const parts: any[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of (msg as any).tool_calls) {
        callMap.set(tc.id, tc.function.name);
        replayedIds.add(tc.id);
        let args: any = {};
        try {
          args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        } catch {
          args = {};
        }
        const fc: any = { name: tc.function.name, args };
        if (tc.id) fc.id = tc.id;
        // Echo the thoughtSignature back on the PART (sibling of functionCall)
        // so thinking-enabled Gemini models accept the replayed functionCall.
        // History written before thought signatures existed (old D1 sessions)
        // has none — use the documented validator-skip value so those don't 400.
        parts.push({
          functionCall: fc,
          thoughtSignature: tc.thoughtSignature || "skip_thought_signature_validator",
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    const role = msg.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: convertContentToParts(msg.content) });
  }
  return { contents, systemInstruction };
}

function toolsToGeminiTools(tools: any[]): any[] {
  if (!tools.length) return [];
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }];
}

function geminiFinishReason(reason: string): string {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  return (reason || "stop").toLowerCase();
}

async function callGemini(
  apiKey: string,
  messages: ChatMessage[],
  tools: any[],
  model: string
): Promise<
  | { choices: Array<{ message: { content?: string; tool_calls?: GroqToolCall[] }; finish_reason: string }> }
  | { _rateLimited: true; model: string }
> {
  const apiModel = GEMINI_MODEL_MAP[model];
  if (!apiModel) return { _rateLimited: true, model };

  const { contents, systemInstruction } = messagesToGeminiContents(messages);
  const maxTokens = GEMINI_MAX_TOKENS[model] ?? 65536;

  const body: Record<string, any> = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const geminiTools = toolsToGeminiTools(tools);
  if (geminiTools.length) body.tools = geminiTools;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_CALL_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${GEMINI_API_BASE}/models/${apiModel}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timeout);
    // Timeout or network failure → try the next model in the chain
    console.warn(`[${model}] Gemini request failed: ${e?.message || e.name}`);
    return { _rateLimited: true, model };
  }

  // Rate limits (429/503) AND server errors (5xx) → fall back to the next model
  if (resp.status === 429 || resp.status === 503 || resp.status >= 500) {
    clearTimeout(timeout);
    return { _rateLimited: true, model };
  }
  if (!resp.ok) {
    // Body read stays under the MODEL_CALL_TIMEOUT_MS abort signal (don't
    // clearTimeout early — a hung body read would otherwise hang the message).
    const err = await resp.text();
    clearTimeout(timeout);
    if (resp.status === 400 && err.includes("not supported")) {
      return { _rateLimited: true, model };
    }
    throw new Error(`Gemini API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  let data: any;
  try {
    data = await resp.json();
    clearTimeout(timeout);
  } catch (e: any) {
    clearTimeout(timeout);
    console.warn(`[${model}] Gemini response read failed: ${e?.message || e.name}`);
    return { _rateLimited: true, model };
  }

  if (data.promptFeedback?.blockReason) {
    console.warn(`[${model}] blocked: ${data.promptFeedback.blockReason}`);
    return { choices: [{ message: { content: "I can't respond to that due to content safety filters." }, finish_reason: "stop" }] };
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    console.warn(`[${model}] no candidates`);
    return { choices: [{ message: { content: "I can't respond to that right now." }, finish_reason: "stop" }] };
  }

  if (candidate.finishReason === "SAFETY") {
    console.warn(`[${model}] finish_reason=SAFETY`);
    return { choices: [{ message: { content: "I can't respond to that due to safety filters." }, finish_reason: "stop" }] };
  }

  const parts = candidate.content?.parts || [];
  let text = "";
  const toolCalls: GroqToolCall[] = [];

  for (const part of parts) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      const fc = part.functionCall;
      toolCalls.push({
        // Gemini 3 models return a unique id per functionCall that must be
        // echoed back in the functionResponse — preserve it when present.
        id: fc.id || `call_gemini_${Date.now()}_${toolCalls.length}`,
        type: "function",
        function: {
          name: fc.name,
          arguments: typeof fc.args === "string"
            ? fc.args
            : JSON.stringify(fc.args),
        },
        // Thought signatures live on the Part itself (sibling of functionCall),
        // NOT inside functionCall. Thinking models (Gemini 2.5/3.x) attach one
        // to the first functionCall part — required on replay or the API
        // rejects the next request with "missing a thought_signature".
        thoughtSignature: part.thoughtSignature,
      });
    }
  }

  const finishReason = geminiFinishReason(candidate.finishReason || "STOP");
  if (finishReason === "length") {
    console.warn(`[${model}] finish_reason=length (${text.length} chars)`);
  }

  return {
    choices: [{
      message: {
        content: text || undefined,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
      finish_reason: finishReason,
    }],
  };
}

// ===================== Simulated Streaming =====================

async function revealText(onStream: StreamCallback | undefined, text: string) {
  if (!onStream || !text) return;
  const step = 500;
  let pos = Math.min(500, text.length);
  let lastPartial = "";
  while (pos < text.length) {
    lastPartial = text.slice(0, pos);
    await onStream(lastPartial, false);
    pos = Math.min(pos + step, text.length);
  }
  if (lastPartial !== text) {
    await onStream(text, true);
  }
}

// ===================== JSON Tool Call Fallback =====================

/** Detect raw JSON function calls in model output (some models output tool calls as text instead of using the API) */
function extractJsonToolCall(text: string): GroqToolCall & { raw: string } | null {
  for (let i = 0; i < text.length; i++) {
    // Try matching with and without spaces after colons
    const substr = text.slice(i);
    if (substr.startsWith('{"type":"function"') || substr.startsWith('{"type": "function"')) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            const raw = text.slice(i, j + 1);
            try {
              const parsed = JSON.parse(raw);
              if (parsed?.type === "function" && parsed?.function?.name && parsed?.function?.arguments) {
                const args = typeof parsed.function.arguments === "string" ? parsed.function.arguments : JSON.stringify(parsed.function.arguments);
                return {
                  id: `call_fallback_${Date.now()}`,
                  type: "function",
                  function: { name: parsed.function.name, arguments: args },
                  raw,
                };
              }
            } catch {}
            break;
          }
        }
      }
      break;
    }
  }
  return null;
}

// ===================== Main AI Processor with GOAP + Tool Loop =====================

const TOOL_KEYWORDS = [
  "remind", "reminder", "search", "look up", "remember", "recall", "movie", "film", "discover", "recommend", "what time", "time in",
  "weather", "forecast", "temperature", "rain", "youtube", "video transcript", "summarize this video", "summarize the video",
  "http",
  "every day", "every week", "every monday", "every tuesday", "every wednesday", "every thursday", "every friday", "every saturday", "every sunday",
  "every hour", "every 2 hours", "daily", "weekly", "weekdays", "weekends",
  "alert me", "notify me", "watch for", "keep an eye", "keyword", "cron",
  "page", "website", "web page", "is it live", "is the site", "site down", "site up", "live check", "url",
  "watch this page", "watch the page", "track this page", "track the page", "page change", "page changed", "any changes", "check the page",
  "what do you know about", "do you know anything about", "knowledge graph", "facts about", "what do you remember about", "tell me about", "connected to", "related to",
];

function needsTools(messages: ChatMessage[]): boolean {
  // Only inspect the latest user message. Scanning the whole history means one
  // old message mentioning "movie"/"remind"/etc. would attach tools to every
  // unrelated follow-up (extra tokens + tool-loop exposure on plain chat).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") {
      const text = m.content.toLowerCase();
      return TOOL_KEYWORDS.some((kw) => text.includes(kw));
    }
  }
  return false;
}

async function processAiInternal(
  env: Env,
  messages: ChatMessage[],
  chatId: string,
  preferredModel: string | undefined,
  onStream?: StreamCallback,
  maxDepth = 5
): Promise<{ text: string; modelUsed: string }> {
  const tools = needsTools(messages) ? getTools(env) : [];

  const isGemini = (m: string) => m.startsWith("gemini-");
  // Gemini models + Llama 4 Scout accept images; Llama 3.3/3.1 on Groq are text-only.
  const isVisionModel = (m: string) => isGemini(m);
  const hasImages = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image_url")
  );

  const chain = preferredModel && FALLBACK_CHAIN.includes(preferredModel)
    ? [preferredModel, ...FALLBACK_CHAIN.filter((m) => m !== preferredModel)]
    : FALLBACK_CHAIN;

  for (let attempt = 0; attempt < chain.length; attempt++) {
    const model = chain[attempt];
    if (hasImages && !isVisionModel(model)) {
      console.warn(`[${model}] skipping (text-only model, images in conversation)`);
      continue;
    }
    const currentMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages));
    let useTools = tools.length > 0;

    for (let turn = 0; turn < maxDepth; turn++) {
      const isGeminiModel = isGemini(model);
      const apiKey = isGeminiModel ? env.GEMINI_API_KEY : env.GROQ_API_KEY;
      if (!apiKey) {
        console.warn(`[${model}] API key not configured, skipping`);
        continue;
      }
      console.log(`[MODEL] ${isGeminiModel ? "Gemini" : "Groq"} :: ${model} :: turn ${turn}/${maxDepth} :: tools ${useTools ? "on" : "off"}`);

      let response:
        | Awaited<ReturnType<typeof callGemini>>
        | Awaited<ReturnType<typeof callGroq>>;
      try {
        response = isGeminiModel
          ? await callGemini(apiKey, currentMessages, useTools ? tools : [], model)
          : await callGroq(apiKey, currentMessages, useTools ? tools : [], model);
      } catch (e: any) {
        // Model-specific API error (e.g. malformed request) — log and fall
        // through to the next model in the chain instead of killing the message.
        console.warn(`[${model}] model call error: ${e?.message || e}`);
        break;
      }

      if ("_rateLimited" in response) break;
      if ("_retry" in response) {
        useTools = false;
        continue;
      }

      const choice = (response as any).choices[0];
      const msg = choice.message;
      const finishReason = choice.finish_reason;

      if (!msg.tool_calls) {
        const content = msg.content || "";
        const jsonToolCall = extractJsonToolCall(content);
        if (jsonToolCall) {
          const result = await handleFunctionCall(env, chatId, jsonToolCall);
          currentMessages.push({ role: "assistant", content: content.replace(jsonToolCall.raw, "").trim() });
          currentMessages.push({ role: "tool", content: result, tool_call_id: jsonToolCall.id, name: jsonToolCall.function.name });
          continue;
        }
        let text = content || "No response.";
        if (finishReason === "length") {
          text += "\n\n_... (response was cut off due to length)_";
        }
        await revealText(onStream, text);
        return { text, modelUsed: model };
      }

      currentMessages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls.map((tc: GroqToolCall) => ({ ...tc })) });
      for (const tc of msg.tool_calls) {
        const result = await handleFunctionCall(env, chatId, tc);
        currentMessages.push({ role: "tool", content: result, tool_call_id: tc.id, name: tc.function.name });
      }
    }
  }

  console.warn(`[MODEL] all models exhausted, chain: ${chain.join(" → ")}`);
  return { text: "I'm hitting rate limits or errors across all models right now. Please try again in a minute 💜", modelUsed: "none" };
}

// ===================== Public API =====================

export async function processAi(
  env: Env,
  history: ChatMessage[],
  chatId: string,
  preferredModel?: string
): Promise<{ text: string; modelUsed: string }> {
  return processAiInternal(env, [...history], chatId, preferredModel);
}

export async function processAiStream(
  env: Env,
  history: ChatMessage[],
  chatId: string,
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

// ===================== Document Text Extraction =====================

const TEXT_EXTENSIONS = new Set([
  "txt", "csv", "json", "xml", "md", "html", "htm", "log",
  "cfg", "ini", "yaml", "yml", "toml", "env",
  "py", "js", "ts", "rs", "go", "java", "c", "cpp", "h", "hpp",
  "sh", "bash", "zsh", "fish", "ps1", "bat",
  "sql", "r", "rb", "php", "swift", "kt", "scala",
  "tex", "rst", "asciidoc", "adoc",
]);

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
];

export function isTextDocument(filename: string, mimeType?: string): boolean {
  if (mimeType && TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) return true;
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? TEXT_EXTENSIONS.has(ext) : false;
}

export function isPdfDocument(mimeType?: string, filename?: string): boolean {
  if (mimeType === "application/pdf") return true;
  return filename?.toLowerCase().endsWith(".pdf") ?? false;
}

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const raw = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buffer);
  const parts: string[] = [];

  // PDF metadata (always uncompressed)
  const infoMatch = raw.match(/<<\s*\/Info\s+(\d+\s+\d+\s+R)/);
  if (infoMatch) {
    const infoRef = infoMatch[1].trim();
    // Try to find the info dict content
    // Match balanced << >> to handle > inside string values
    const dictStart = raw.search(new RegExp(`${infoRef.replace(/\s+/g, '\\s+')}\\s*obj\\s*<<`));
    if (dictStart !== -1) {
      let depth = 2;
      let pos = dictStart + raw.slice(dictStart).indexOf("<<") + 2;
      while (depth > 0 && pos < raw.length) {
        if (raw[pos] === "<" && raw[pos + 1] === "<") { depth++; pos++; }
        else if (raw[pos] === ">" && raw[pos + 1] === ">") { depth--; pos++; }
        pos++;
      }
      const infoDict = raw.slice(dictStart, pos);
      const meta = infoDict.match(/\/Title\s*\(((?:[^()\\]|\\.)*)\)|\/Author\s*\(((?:[^()\\]|\\.)*)\)|\/Subject\s*\(((?:[^()\\]|\\.)*)\)/g);
      if (meta) {
        parts.push("[Document Info]");
        for (const m of meta) {
          const val = m.replace(/\/\w+\s*\(/, "").replace(/\)$/, "");
          parts.push(m.split(/\s/)[0].slice(1) + ": " + val);
        }
      }
    }
  }

  // Extract text from uncompressed content streams: (text) Tj / TJ / '
  const textOps = [
    ...raw.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g),
    ...raw.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*'/g),
    ...raw.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*"/g),
  ];
  for (const m of textOps) {
    parts.push(m[1]);
  }

  // TJ arrays: [(text) num (text)] TJ
  const tjArrays = raw.matchAll(/\[((?:[^\[\]\\]|\\.)*)\]\s*TJ/g);
  for (const arr of tjArrays) {
    const contents = arr[1].match(/\(((?:[^()\\]|\\.)*)\)/g);
    if (contents) {
      for (const c of contents) {
        parts.push(c.slice(1, -1));
      }
    }
  }

  if (!parts.length) {
    return "This PDF appears to be a scanned document or image-based PDF. I cannot extract text from it.";
  }

  // Decode PDF escape sequences
  const decoded = parts
    .map((t) =>
      t
        .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
        .replace(/\\(n)/g, "\n")
        .replace(/\\(r)/g, "\r")
        .replace(/\\(t)/g, "\t")
        .replace(/\\(.)/g, "$1")
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return decoded.slice(0, 10000) + (decoded.length > 10000 ? "\n\n[truncated at 10,000 characters]" : "");
}

// ===================== Image to base64 =====================

export async function fileToBase64(fileUrl: string): Promise<string> {
  const resp = await fetch(fileUrl);
  const blob = await resp.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ===================== LaTeX Renderer =====================

export async function renderLatex(env: Env, chatId: number, formula: string): Promise<string> {
  const body = new URLSearchParams({
    formula: `\\[${formula}\\]`,
    format: "png",
    fsize: "20",
    fcolor: "FFFFFF",
    mode: "0",
    out: "1",
    remhost: "quicklatex.com",
  });
  const resp = await fetch("https://quicklatex.com/latex3.f", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) return "LaTeX render failed.";
  const raw = await resp.text();
  const lines = raw.trim().split("\n");
  if (lines[0] !== "0" || !lines[1]) return "LaTeX render error.";
  const url = lines[1].trim().split(/\s+/)[0];
  try {
    const imgResp = await fetch(url);
    if (imgResp.ok) {
      const blob = await imgResp.blob();
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("photo", blob, "latex.png");
      const sendResp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
      if (!sendResp.ok) console.log("sendPhoto failed:", await sendResp.text());
    }
  } catch (e) { console.log("sendPhoto error:", e); }
  return "Rendered LaTeX formula as image above.";
}

// ===================== Mermaid Renderer =====================

function utf8ToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function renderMermaid(env: Env, chatId: number, diagram: string): Promise<string> {
  const encoded = utf8ToBase64Url(diagram);
  const renderUrl = `https://mermaid.ink/img/${encoded}`;
  const resp = await fetch(renderUrl);
  if (!resp.ok) return "Mermaid render failed.";
  try {
    const blob = await resp.blob();
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", blob, "mermaid.png");
    const sendResp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
    if (!sendResp.ok) console.log("sendPhoto failed:", await sendResp.text());
  } catch (e) { console.log("sendPhoto error:", e); }
  return "Rendered Mermaid diagram as image above.";
}
