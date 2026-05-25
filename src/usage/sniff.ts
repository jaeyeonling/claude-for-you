export type SniffedUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  serviceTier: string | undefined;
}>;

const SSE_EVENT_DELIM = '\n\n';

export const safeParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const extractUsage = (
  parsed: unknown,
): {
  input: number | undefined;
  output: number | undefined;
  tier: string | undefined;
} | null => {
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  // message_start payload nests usage under `message.usage`.
  // message_delta and final non-stream responses expose `usage` at the top.
  const nested = obj.message as Record<string, unknown> | undefined;
  const u = (obj.usage ?? nested?.usage) as Record<string, unknown> | undefined;
  if (!u) return null;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
  const tier = typeof u.service_tier === 'string' ? u.service_tier : undefined;
  if (input === undefined && output === undefined && tier === undefined) return null;
  return { input, output, tier };
};

const parseSseBlock = (
  block: string,
): {
  input: number | undefined;
  output: number | undefined;
  tier: string | undefined;
} | null => {
  for (const line of block.split('\n')) {
    if (line.startsWith('data: ')) {
      const u = extractUsage(safeParseJson(line.slice(6)));
      if (u) return u;
    }
  }
  return null;
};

/**
 * Pass-through TransformStream that observes usage tokens without buffering
 * the full response. SSE: parses each event block as it arrives. JSON: buffers
 * (small) and parses on flush.
 */
export const sniffUsage = (
  input: ReadableStream<Uint8Array>,
  contentType: string,
  onComplete: (usage: SniffedUsage) => void,
): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder('utf-8');
  const isStream = contentType.toLowerCase().startsWith('text/event-stream');
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let serviceTier: string | undefined;
  // `downstreamOpen` guards against the race where the consumer (HTTP server
  // → client socket) finishes reading or closes before the source upstream
  // body is fully drained. In Bun this surfaces as
  // "Invalid state: Controller is already closed" thrown by enqueue/close.
  // We accumulate usage data regardless so onComplete still fires for
  // accounting + billing-monitor + canary trip.
  let downstreamOpen = true;

  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (downstreamOpen) {
          try {
            controller.enqueue(chunk);
          } catch {
            downstreamOpen = false;
          }
        }
        buffer += decoder.decode(chunk, { stream: true });
        if (!isStream) return;
        while (true) {
          const idx = buffer.indexOf(SSE_EVENT_DELIM);
          if (idx === -1) break;
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + SSE_EVENT_DELIM.length);
          const u = parseSseBlock(block);
          if (!u) continue;
          if (u.input !== undefined) inputTokens = Math.max(inputTokens, u.input);
          if (u.output !== undefined) outputTokens = Math.max(outputTokens, u.output);
          if (u.tier !== undefined) serviceTier = u.tier;
        }
      },
      flush() {
        buffer += decoder.decode();
        if (!isStream) {
          const u = extractUsage(safeParseJson(buffer));
          if (u) {
            if (u.input !== undefined) inputTokens = u.input;
            if (u.output !== undefined) outputTokens = u.output;
            if (u.tier !== undefined) serviceTier = u.tier;
          }
        }
        try {
          onComplete({ inputTokens, outputTokens, serviceTier });
        } catch {
          // onComplete is best-effort accounting — never let it surface as
          // an unhandled stream error that masks the upstream success.
        }
      },
    }),
  );
};
