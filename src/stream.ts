export interface StreamChunk {
  content?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  finishReason?: "stop" | "tool_calls" | "length" | null;
}

class SSEDecoder {
  private event: string | null = null;
  private data: string[] = [];

  decode(line: string): { event?: string | null; data?: string } | null {
    if (line.endsWith("\r")) line = line.substring(0, line.length - 1);
    if (!line) {
      if (!this.event && !this.data.length) return null;
      const sse = { event: this.event, data: this.data.join("\n") };
      this.event = null;
      this.data = [];
      return sse;
    }
    if (line.startsWith(":")) return null;
    const idx = line.indexOf(":");
    const field = idx >= 0 ? line.substring(0, idx) : line;
    let value = idx >= 0 ? line.substring(idx + 1) : "";
    if (value.startsWith(" ")) value = value.substring(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return null;
  }
}

class LineDecoder {
  private buffer: string[] = [];
  private trailingCR = false;
  private textDecoder = new TextDecoder();

  decode(chunk: Uint8Array): string[] {
    let text = this.textDecoder.decode(chunk, { stream: true });
    if (this.trailingCR) {
      text = `\r${text}`;
      this.trailingCR = false;
    }
    if (text.endsWith("\r")) {
      this.trailingCR = true;
      text = text.slice(0, -1);
    }
    if (!text) return [];
    const trailingNewline = text.endsWith("\n") || text.endsWith("\r");
    let lines = text.split(/\r\n|[\n\r]/g);
    if (lines.length === 1 && !trailingNewline) {
      this.buffer.push(lines[0]);
      return [];
    }
    if (this.buffer.length > 0) {
      lines = [this.buffer.join("") + lines[0], ...lines.slice(1)];
      this.buffer = [];
    }
    if (!trailingNewline) this.buffer = [lines.pop() || ""];
    return lines;
  }

  flush(): string[] {
    if (!this.buffer.length && !this.trailingCR) return [];
    const lines = [this.buffer.join("")];
    this.buffer = [];
    this.trailingCR = false;
    return lines;
  }
}

export async function* iterateStream(response: Response): AsyncGenerator<StreamChunk> {
  if (!response.body) throw new Error("No response body");

  const lineDecoder = new LineDecoder();
  const sseDecoder = new SSEDecoder();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCallAccum: Map<
    number,
    { id: string; function: { name: string; arguments: string } }
  > = new Map();

  function flushToolCalls(): StreamChunk["toolCalls"] {
    if (toolCallAccum.size === 0) return undefined;
    const calls = Array.from(toolCallAccum.entries())
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    toolCallAccum.clear();
    return calls;
  }

  let done = false;
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    if (value) {
      const text = decoder.decode(value, { stream: !done });
      for (const line of lineDecoder.decode(new TextEncoder().encode(text))) {
        const sse = sseDecoder.decode(line);
        if (!sse?.data) continue;
        if (sse.data === "[DONE]") return;

        try {
          const parsed = JSON.parse(sse.data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta || {};
          const chunk: StreamChunk = {};

          if (delta.content) chunk.content = delta.content;

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccum.has(idx)) {
                toolCallAccum.set(idx, {
                  id: tc.id || "",
                  function: { name: "", arguments: "" },
                });
              }
              const acc = toolCallAccum.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
            }
          }

          if (choice.finish_reason) {
            chunk.finishReason = choice.finish_reason;
            if (choice.finish_reason === "tool_calls") {
              chunk.toolCalls = flushToolCalls();
            }
          }

          yield chunk;
        } catch {}
      }
    }
  }

  for (const line of lineDecoder.flush()) {
    const sse = sseDecoder.decode(line);
    if (sse?.data && sse.data !== "[DONE]") {
      try {
        const parsed = JSON.parse(sse.data);
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) yield { finishReason: choice.finish_reason };
      } catch {}
    }
  }
}
