/**
 * Tee the upstream response stream into two branches:
 *   - `stream`: forwarded byte-for-byte to the proxy client (HTTP response).
 *   - an internal reader: drains the second branch fully into a string for
 *     messages_log capture.
 *
 * Why `tee()` over `pipeThrough(TransformStream)`:
 *   The WHATWG Transformer interface (as typed in lib.dom.d.ts) has no
 *   cancel callback, so a downstream client disconnect leaves a Transformer-
 *   based tap's "stream ended" promise pending indefinitely — the log write
 *   never fires. With `tee()`, the two branches are independent: even if the
 *   client cancels its branch, our internal reader keeps pulling from the
 *   upstream source until it finishes naturally, so the log captures the
 *   full Anthropic response.
 *
 * Cost: the tee buffer holds chunks read by one branch but not the other.
 * For Claude responses (typically <512 KB SSE, <300 KB JSON) this is small.
 * If downstream cancels early we trade a little Anthropic bandwidth for
 * complete logs — that matches the operator's stated "log everything" goal.
 */
export interface ResponseTap {
  readonly stream: ReadableStream<Uint8Array>;
  /** Snapshot of accumulated bytes as UTF-8. Call after `done` resolves. */
  readonly getRaw: () => string;
  /** Resolves when the upstream source finishes (or errors). Always settles —
   * never hangs even when the proxy client disconnects mid-stream. */
  readonly done: Promise<void>;
}

export const tapResponseBody = (input: ReadableStream<Uint8Array>): ResponseTap => {
  const [forClient, forLog] = input.tee();
  const decoder = new TextDecoder('utf-8');
  let raw = '';

  const done = (async (): Promise<void> => {
    const reader = forLog.getReader();
    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } catch {
      // Upstream errored mid-stream — keep whatever was accumulated. The
      // caller writes the log with the partial body so the operator can see
      // how far Anthropic got before the failure.
    } finally {
      reader.releaseLock();
    }
  })();

  return Object.freeze({ stream: forClient, getRaw: () => raw, done });
};
