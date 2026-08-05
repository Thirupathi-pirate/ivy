/**
 * Shared Telegram-HTML formatting utilities.
 * Used by both the bot routes (src/index.ts) and the AI layer (src/ai.ts)
 * so raw LLM markdown can be rendered safely on Telegram without circular imports.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Remove HTML tags/entities — used for plain-text fallback so raw <b> never leaks */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Stream a partial safely: only complete lines are converted so HTML tags are never split */
export function safeHtmlPartial(partial: string, done: boolean): string {
  if (done) return mdToTelegramHtml(partial);
  const nl = partial.lastIndexOf("\n");
  if (nl <= 0) return ""; // no complete line yet — wait for more
  return mdToTelegramHtml(partial.slice(0, nl + 1));
}

/**
 * Convert LLM markdown to Telegram HTML (parse_mode: "HTML").
 * Telegram Markdown V1 fails the ENTIRE message on a single unbalanced
 * `*`/`_`, which caused raw markup to be shown instead of formatted text.
 * HTML only needs <, >, & escaped — far more robust against model output.
 */
export function mdToTelegramHtml(text: string): string {
  // 1. Extract code spans first so their contents aren't mangled
  const codeBlocks: string[] = [];
  let out = text
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
      codeBlocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`);
      return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    })
    .replace(/`([^`\n]+)`/g, (_m, code: string) => {
      codeBlocks.push(`<code>${escapeHtml(code)}</code>`);
      return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });

  // 2. Escape HTML entities in the remaining text
  out = escapeHtml(out);

  // 3. Headings → bold
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // 4. Bold **x**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  // 5. Bullet "* item" → "• item", then italic *x*
  out = out.replace(/^(\s*)\*\s+/gm, "$1• ");
  out = out.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  // 6. Inline links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`;
  });

  // 7. Restore code spans
  return out.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)]);
}
