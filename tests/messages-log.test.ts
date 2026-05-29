import { describe, expect, test } from 'bun:test';
import {
  createNullMessageLogStore,
  extractModel,
  extractPreview,
  extractResponseMeta,
} from '../src/usage/messages-log.js';

describe('extractPreview', () => {
  test('returns string content of the last user message', () => {
    const body = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second user message' },
      ],
    };
    expect(extractPreview(body)).toBe('second user message');
  });

  test('returns text-block content when content is an array', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ignored' },
            { type: 'text', text: 'real prompt here' },
          ],
        },
      ],
    };
    expect(extractPreview(body)).toBe('real prompt here');
  });

  test('truncates to the configured max length', () => {
    const body = { messages: [{ role: 'user', content: 'a'.repeat(500) }] };
    expect(extractPreview(body, 10)).toBe('aaaaaaaaaa');
  });

  test('returns empty string when no user messages present', () => {
    expect(extractPreview({ messages: [{ role: 'assistant', content: 'x' }] })).toBe('');
    expect(extractPreview({})).toBe('');
    expect(extractPreview(null)).toBe('');
    expect(extractPreview('not an object')).toBe('');
  });
});

describe('extractModel', () => {
  test('reads top-level model string', () => {
    expect(extractModel({ model: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
  });

  test('returns null for non-string or missing model', () => {
    expect(extractModel({ model: 42 })).toBeNull();
    expect(extractModel({})).toBeNull();
    expect(extractModel(null)).toBeNull();
  });
});

describe('extractResponseMeta', () => {
  test('extracts token + tier + stop_reason from non-streaming JSON', () => {
    const meta = extractResponseMeta({
      kind: 'json',
      body: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
          service_tier: 'standard',
        },
        stop_reason: 'end_turn',
      },
    });
    expect(meta.inputTokens).toBe(100);
    expect(meta.outputTokens).toBe(50);
    expect(meta.cacheReadTokens).toBe(30);
    expect(meta.cacheCreationTokens).toBe(10);
    expect(meta.serviceTier).toBe('standard');
    expect(meta.stopReason).toBe('end_turn');
  });

  test('walks SSE data: lines and takes the max token count', () => {
    // message_start carries initial usage with cache fields; message_delta
    // updates output_tokens as the assistant streams; delta.stop_reason
    // arrives in the final message_delta event.
    const raw = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 200, output_tokens: 1, cache_read_input_tokens: 50, service_tier: 'standard' } } })}`,
      ``,
      `event: message_delta`,
      `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 45 }, delta: { stop_reason: 'end_turn' } })}`,
      ``,
    ].join('\n');
    const meta = extractResponseMeta({ kind: 'sse', raw });
    expect(meta.inputTokens).toBe(200);
    expect(meta.outputTokens).toBe(45);
    expect(meta.cacheReadTokens).toBe(50);
    expect(meta.stopReason).toBe('end_turn');
    expect(meta.serviceTier).toBe('standard');
  });

  test('returns zero meta for null body', () => {
    const meta = extractResponseMeta(null);
    expect(meta.inputTokens).toBe(0);
    expect(meta.stopReason).toBeNull();
  });

  test('returns zero meta for opaque text body', () => {
    const meta = extractResponseMeta({ kind: 'text', raw: 'rate_limit_error' });
    expect(meta.inputTokens).toBe(0);
    expect(meta.stopReason).toBeNull();
  });

  test('tolerates malformed SSE lines', () => {
    const raw = 'data: not-json\n\ndata: {"type":"x"}\n\n';
    const meta = extractResponseMeta({ kind: 'sse', raw });
    expect(meta.inputTokens).toBe(0);
  });
});

describe('createNullMessageLogStore', () => {
  test('record is a no-op and list returns empty', async () => {
    const store = createNullMessageLogStore();
    await store.record({
      id: 'x',
      ts: new Date(),
      userName: 'u',
      model: null,
      status: 200,
      streaming: false,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      serviceTier: null,
      stopReason: null,
      clientIp: null,
      userAgent: null,
      requestBody: {},
      responseBody: null,
      errorMessage: null,
    });
    expect(await store.list({ limit: 100 })).toEqual([]);
    expect(await store.get('x')).toBeNull();
  });
});
