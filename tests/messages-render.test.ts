import { describe, expect, test } from 'bun:test';
import type { MessageLogRecord, MessageLogSummary } from '../src/usage/messages-log.js';
import { renderMessageDetail, renderMessagesList } from '../src/admin/messages-render.js';

const sampleSummary = (over: Partial<MessageLogSummary> = {}): MessageLogSummary => ({
  id: '00000000-0000-0000-0000-000000000001',
  ts: new Date('2026-05-30T10:00:00Z'),
  userName: 'alice',
  model: 'claude-sonnet-4-6',
  status: 200,
  streaming: true,
  durationMs: 1234,
  inputTokens: 100,
  outputTokens: 50,
  serviceTier: 'standard',
  preview: 'hello world',
  ...over,
});

const sampleRecord = (over: Partial<MessageLogRecord> = {}): MessageLogRecord => ({
  id: '00000000-0000-0000-0000-000000000001',
  ts: new Date('2026-05-30T10:00:00Z'),
  userName: 'alice',
  model: 'claude-sonnet-4-6',
  status: 200,
  streaming: true,
  durationMs: 1234,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 20,
  cacheCreationTokens: 5,
  serviceTier: 'standard',
  stopReason: 'end_turn',
  clientIp: '10.0.0.1',
  userAgent: 'claude-cli/1.0',
  requestBody: {
    model: 'claude-sonnet-4-6',
    system: 'You are Claude.',
    messages: [{ role: 'user', content: 'hi' }],
  },
  responseBody: { kind: 'json', body: { content: [{ type: 'text', text: 'hello' }] } },
  errorMessage: null,
  servedBy: 'pool-0',
  bypassMetadata: {
    inboundHeaders: { 'anthropic-beta': 'context-1m-2025-08-07' },
    outboundHeaders: { authorization: 'Bearer [REDACTED]', 'anthropic-beta': 'oauth' },
    upstreamHeaders: { 'request-id': 'req_abc' },
    unknownInboundHeaders: [{ name: 'x-mystery', length: 42 }],
    unknownOutboundHeaders: [],
    unknownUpstreamHeaders: [{ name: 'x-edge-cache', length: 4 }],
    canary: { useCandidate: false },
  },
  ...over,
});

describe('renderMessagesList', () => {
  test('renders a row with HTML-escaped preview', () => {
    const html = renderMessagesList({
      rows: [sampleSummary({ preview: '<script>alert(1)</script>' })],
      filters: { q: '', user: '', model: '', status: 'all', source: 'all' },
      nextCursor: null,
      hasPrev: false,
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('/admin/messages/00000000-0000-0000-0000-000000000001');
  });

  test('shows empty state when no rows', () => {
    const html = renderMessagesList({
      rows: [],
      filters: { q: '', user: '', model: '', status: 'all', source: 'all' },
      nextCursor: null,
      hasPrev: false,
    });
    expect(html).toContain('no matching messages');
  });

  test('emits older→ link only when nextCursor is set', () => {
    const withCursor = renderMessagesList({
      rows: [sampleSummary()],
      filters: { q: 'foo', user: '', model: '', status: 'all', source: 'all' },
      nextCursor: '2026-05-30T09:00:00.000Z',
      hasPrev: false,
    });
    expect(withCursor).toContain('older →');
    expect(withCursor).toContain('before=2026-05-30');
    expect(withCursor).toContain('q=foo');

    const noCursor = renderMessagesList({
      rows: [sampleSummary()],
      filters: { q: '', user: '', model: '', status: 'all', source: 'all' },
      nextCursor: null,
      hasPrev: false,
    });
    expect(noCursor).not.toContain('older →');
  });

  test('preserves filter values in the form inputs', () => {
    const html = renderMessagesList({
      rows: [],
      filters: { q: 'bug', user: 'alice', model: 'claude-haiku-4-5', status: 'error', source: 'all' },
      nextCursor: null,
      hasPrev: false,
    });
    expect(html).toContain('value="bug"');
    expect(html).toContain('value="alice"');
    expect(html).toContain('value="claude-haiku-4-5"');
    expect(html).toContain('option value="error" selected');
  });

  test('renders the source badge per row and marks the source filter selected (#144)', () => {
    const html = renderMessagesList({
      rows: [
        sampleSummary({ source: 'proxy', status: 429 }),
        sampleSummary({ id: '00000000-0000-0000-0000-000000000002', source: 'upstream', status: 429 }),
        sampleSummary({ id: '00000000-0000-0000-0000-000000000003', source: null }),
      ],
      filters: { q: '', user: '', model: '', status: 'all', source: 'proxy' },
      nextCursor: null,
      hasPrev: false,
    });
    // Distinct badges for proxy vs upstream (the whole point of #144).
    expect(html).toContain('>proxy</span>');
    expect(html).toContain('>upstream</span>');
    // Legacy/null source renders the mute dash, never crashes.
    expect(html).toContain('>—</span>');
    // The source <select> reflects the active filter.
    expect(html).toContain('option value="proxy" selected');
  });

  test('a successful upstream row does NOT get an error-colored source badge (#144)', () => {
    const html = renderMessagesList({
      rows: [sampleSummary({ source: 'upstream', status: 200 })],
      filters: { q: '', user: '', model: '', status: 'all', source: 'all' },
      nextCursor: null,
      hasPrev: false,
    });
    // upstream is written for every request that reached Anthropic, including
    // 2xx success — its badge must be categorical (b-info), never the b-bad
    // class used for error statuses, or healthy traffic reads as failing.
    expect(html).toContain('class="badge b-info"');
    expect(html).toContain('>upstream</span>');
    expect(html).not.toContain('<span class="badge b-bad">upstream</span>');
  });
});

describe('renderMessageDetail', () => {
  test('shows metadata + escaped request body', () => {
    const html = renderMessageDetail(sampleRecord());
    expect(html).toContain('alice');
    expect(html).toContain('claude-sonnet-4-6');
    expect(html).toContain('end_turn');
    expect(html).toContain('You are Claude.');
    // body content must be HTML-escaped
    expect(html).not.toContain('<script>');
  });

  test('reassembles SSE deltas into an assistant text block', () => {
    const sseRaw = [
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello, ' } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } })}`,
      '',
    ].join('\n');
    const html = renderMessageDetail(
      sampleRecord({ responseBody: { kind: 'sse', raw: sseRaw } }),
    );
    expect(html).toContain('Hello, world!');
    expect(html).toContain('raw SSE');
  });

  test('renders the text kind body verbatim', () => {
    const html = renderMessageDetail(
      sampleRecord({
        status: 502,
        streaming: false,
        responseBody: { kind: 'text', raw: '<html>bad gateway</html>' },
      }),
    );
    expect(html).toContain('non-JSON body');
    expect(html).toContain('&lt;html&gt;bad gateway&lt;/html&gt;');
  });

  test('shows error badge when errorMessage is present', () => {
    const html = renderMessageDetail(
      sampleRecord({
        status: 429,
        errorMessage: 'rate_limit_error',
        responseBody: { kind: 'json', body: { error: { message: 'rate_limit_error' } } },
      }),
    );
    expect(html).toContain('rate_limit_error');
    expect(html).toContain('b-bad');
  });
});
