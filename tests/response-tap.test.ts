import { describe, expect, test } from 'bun:test';
import { tapResponseBody } from '../src/proxy/response-tap.js';

const toStream = (chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
};

const drain = async (s: ReadableStream<Uint8Array>): Promise<string> => {
  const dec = new TextDecoder('utf-8');
  let out = '';
  const reader = s.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
};

describe('tapResponseBody', () => {
  test('passes bytes through unchanged and accumulates the full body', async () => {
    const tap = tapResponseBody(toStream(['hello ', 'world', '!']));
    const consumed = await drain(tap.stream);
    await tap.done;
    expect(consumed).toBe('hello world!');
    expect(tap.getRaw()).toBe('hello world!');
  });

  test('handles UTF-8 split across chunks', async () => {
    // '한' is 0xED 0x95 0x9C — split between chunks to exercise the
    // streaming decoder.
    const enc = new TextEncoder();
    const bytes = enc.encode('한글');
    const split1 = bytes.slice(0, 2);
    const split2 = bytes.slice(2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(split1);
        controller.enqueue(split2);
        controller.close();
      },
    });
    const tap = tapResponseBody(stream);
    await drain(tap.stream);
    await tap.done;
    expect(tap.getRaw()).toBe('한글');
  });

  test('captures the full upstream body even when downstream cancels early', async () => {
    // Regression: previously `done` only resolved on flush, so a client
    // disconnect mid-stream silently lost the log write. Now via tee() the
    // internal reader keeps pulling upstream after downstream cancels.
    const tap = tapResponseBody(toStream(['a', 'b', 'c']));
    const reader = tap.stream.getReader();
    await reader.read();
    await reader.cancel();
    await tap.done; // must resolve, even though downstream gave up
    expect(tap.getRaw()).toBe('abc');
  });
});
