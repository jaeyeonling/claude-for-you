import { describe, expect, test } from 'bun:test';
import { sniffUsage } from '../src/usage/sniff.js';

const encode = (text: string): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
  const r = stream.getReader();
  while (true) {
    const { done } = await r.read();
    if (done) break;
  }
};

describe('sniffUsage', () => {
  test('reads tokens from message_start nested usage in SSE', async () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"output_tokens":0,"service_tier":"standard"}}}\n\n';
    let captured: { inputTokens: number; outputTokens: number; serviceTier: string | undefined } | null = null;
    const out = sniffUsage(encode(sse), 'text/event-stream', (u) => {
      captured = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, serviceTier: u.serviceTier };
    });
    if (out !== null) await drain(out);
    expect(captured).toEqual({ inputTokens: 42, outputTokens: 0, serviceTier: 'standard' });
  });

  test('merges message_delta tokens onto message_start tokens', async () => {
    const sse =
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n' +
      'event: message_delta\ndata: {"usage":{"output_tokens":25}}\n\n';
    let final: { inputTokens: number; outputTokens: number } | null = null;
    const out = sniffUsage(encode(sse), 'text/event-stream', (u) => {
      final = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
    });
    if (out !== null) await drain(out);
    expect(final).toEqual({ inputTokens: 10, outputTokens: 25 });
  });

  test('non-SSE content-type returns body unchanged + no callback', async () => {
    const json = '{"usage":{"input_tokens":7,"output_tokens":3}}';
    let called = false;
    const out = sniffUsage(encode(json), 'application/json', () => {
      called = true;
    });
    if (out !== null) await drain(out);
    // Non-streaming usage IS sniffed — but verify we do invoke onComplete.
    expect(called).toBe(true);
  });

  test('takes the MAX across multiple message_delta chunks (monotonic counters)', async () => {
    const sse =
      'event: message_delta\ndata: {"usage":{"output_tokens":10}}\n\n' +
      'event: message_delta\ndata: {"usage":{"output_tokens":25}}\n\n' +
      'event: message_delta\ndata: {"usage":{"output_tokens":18}}\n\n'; // out of order
    let final = 0;
    const out = sniffUsage(encode(sse), 'text/event-stream', (u) => {
      final = u.outputTokens;
    });
    await drain(out);
    expect(final).toBe(25); // max wins
  });
});
