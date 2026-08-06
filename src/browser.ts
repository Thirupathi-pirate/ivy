/**
 * Browser automation module — Cloudflare Browser Run + @cloudflare/puppeteer.
 *
 * Patterns borrowed from:
 *  - cloudflare/moltworker       → browser session reuse across calls (global cache + keep_alive)
 *  - cloudflare/queues-web-crawler → launch retry on transient failure
 *  - G4brym/workers-firecrawl    → getBrowser() + extractContent() (main-content-only cleanup, popups, links)
 *  - cloudflare/workers-sdk      → fixtures/browser-run (KV screenshot cache, sessionId API)
 *
 * Chromium only. Camoufox/Firefox anti-detect forks are NOT supported by
 * Browser Run — those need a Python sidecar (e.g. `python -m camoufox server`).
 * Without the `browser` binding every function reports `enabled: false` so the
 * bot degrades gracefully to fetch_url.
 */
import puppeteer from "@cloudflare/puppeteer";
import type { Browser, Page } from "@cloudflare/puppeteer";

/** Minimal env shape this module needs (the Worker's Env satisfies it). */
export interface BrowserEnv {
  BROWSER?: any;
  IVY_KV?: KVNamespace;
}

export interface ExtractResult {
  ok: boolean;
  title?: string;
  description?: string;
  content?: string;
  links?: string[];
  url?: string;
  status?: number;
  error?: string;
}

/** goto/screenshot budget — must fit the 30s waitUntil window next to model calls. */
export const BROWSER_TOOL_TIMEOUT_MS = 12_000;
/** Idle before we drop the cached browser handle and launch a fresh one. */
const SESSION_IDLE_MS = 300_000;
/** Screenshot cache TTL in KV (1h — pages go stale). */
const SHOT_CACHE_TTL = 3_600;

// Per-isolate session cache. `globalThis` persists between requests on the same
// isolate, so a browser launched by an earlier tool call is reused instead of
// paying the ~1-3s launch cost again inside the 30s waitUntil budget.
const G = globalThis as any;
G.__IVY_BROWSER__ = G.__IVY_BROWSER__ || { browser: null as Browser | null, lastUsed: 0 };

export function browserEnabled(env: BrowserEnv): boolean {
  return !!env.BROWSER;
}

/** Reuse a live browser session when possible, else launch (with one retry). */
export async function getBrowser(env: BrowserEnv): Promise<Browser> {
  const cache = G.__IVY_BROWSER__;
  if (cache.browser && Date.now() - cache.lastUsed < SESSION_IDLE_MS) {
    try {
      if (cache.browser.isConnected()) return cache.browser;
    } catch {
      /* stale handle — relaunch */
    }
  }
  try {
    cache.browser = await puppeteer.launch(env.BROWSER, { keep_alive: 600_000 });
  } catch (first) {
    // queues-web-crawler pattern: transient launch failures deserve one retry
    await new Promise((r) => setTimeout(r, 600));
    cache.browser = await puppeteer.launch(env.BROWSER, { keep_alive: 600_000 });
  }
  cache.lastUsed = Date.now();
  return cache.browser;
}

async function newPage(env: BrowserEnv): Promise<{ browser: Browser; page: Page }> {
  const browser = await getBrowser(env);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.setDefaultTimeout(BROWSER_TOOL_TIMEOUT_MS);
  return { browser, page };
}

const toAbsUrl = (raw: string): string => (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);

/**
 * firecrawl-style rendered extraction: domcontentloaded + popup close +
 * main-content-only cleanup (strip script/style/nav/header/footer) + links.
 */
export async function extractContent(
  env: BrowserEnv,
  rawUrl: string,
  selector?: string,
): Promise<ExtractResult> {
  const url = toAbsUrl(rawUrl);
  let page: Page | null = null;
  try {
    const { browser, page: p } = await newPage(env);
    page = p;
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: BROWSER_TOOL_TIMEOUT_MS,
    });
    const status = resp ? resp.status() : 0;

    // Close cookie/annoyance popups before reading (firecrawl pattern)
    await page
      .evaluate(() => {
        const doc = (globalThis as any).document;
        const btns = Array.from(doc.querySelectorAll("button, a")).filter((el: any) => {
          const t = (el.textContent || "").toLowerCase();
          return t.includes("close") || t.includes("×") || t.includes("accept");
        });
        btns.forEach((b: any) => b.click());
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    const title = await page.title().catch(() => url);

    if (selector) {
      const el = await page.$(selector);
      const content = el
        ? await el.evaluate((n: any) => (n as any).innerText || "")
        : null;
      return {
        ok: true,
        title,
        url: page.url(),
        status,
        content: content === null ? undefined : cleanText(content),
        error: content === null ? `No element matched selector "${selector}".` : undefined,
      };
    }

    const { description, content } = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const meta = doc.querySelector('meta[name="description"]');
      const desc = meta ? meta.getAttribute("content") || "" : "";
      const body = doc.body.cloneNode(true);
      // main-content-only: strip navigation cruft before reading text
      body.querySelectorAll("script, style, noscript, nav, header, footer, aside, iframe, svg").forEach((el: any) => el.remove());
      return { description: desc, content: body.innerText || "" };
    });

    const links = await page
      .evaluate(() => {
        const doc = (globalThis as any).document;
        return Array.from(doc.querySelectorAll("a"))
          .map((a: any) => a.href)
          .filter((h: string) => h.startsWith("http"));
      })
      .catch(() => [] as string[]);

    return { ok: true, title, description, content: cleanText(content), links: dedupe(links).slice(0, 20), url: page.url(), status };
  } catch (e: any) {
    return { ok: false, url, error: e?.message || String(e) };
  } finally {
    // Close the PAGE only — keep the browser session alive for the next call.
    if (page) await page.close().catch(() => {});
  }
}

/** Screenshot: KV-cached (fixture pattern), PNG bytes out. */
export async function screenshotPage(env: BrowserEnv, rawUrl: string): Promise<{ buffer?: Buffer; cached?: boolean; error?: string }> {
  const url = toAbsUrl(rawUrl);
  const kvKey = `shot:${url}`;
  if (env.IVY_KV) {
    try {
      const hit = await env.IVY_KV.get(kvKey, { type: "arrayBuffer" });
      if (hit) return { buffer: Buffer.from(hit), cached: true };
    } catch {}
  }
  let page: Page | null = null;
  try {
    const { browser, page: p } = await newPage(env);
    page = p;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_TOOL_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, 1200)); // let JS paint
    const buffer = (await page.screenshot({ type: "png", fullPage: false })) as Buffer;
    if (env.IVY_KV) {
      await env.IVY_KV.put(kvKey, buffer, { expirationTtl: SHOT_CACHE_TTL }).catch(() => {});
    }
    return { buffer };
  } catch (e: any) {
    return { error: e?.message || String(e) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

function cleanText(t: string): string {
  return t.replace(/\n{3,}/g, "\n\n").trim().slice(0, 15_000);
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
