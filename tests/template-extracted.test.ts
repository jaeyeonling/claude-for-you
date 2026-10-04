import { describe, expect, test } from 'bun:test';
import {
  createExtractedTemplate,
  mergeAndFilterAnthropicBeta,
  resolveUserAgent,
} from '../src/template/extracted.js';
import snapshot from '../src/template/cc-snapshot.json';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createLogger, setLogger, type Logger } from '../src/lib/logger.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SNAPSHOT_UA = (snapshot.headerValues as Array<{ name: string; value: string }>).find(
  (h) => h.name === 'user-agent',
)?.value as string;

const BASELINE =
  'claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05';

describe('mergeAndFilterAnthropicBeta', () => {
  test('preserves baseline when client sends nothing', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta(BASELINE, '');

    expect(value.split(',').sort()).toEqual(BASELINE.split(',').sort());
    expect(stripped).toEqual([]);
  });

  test('unions baseline with client-only flags', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta(
      BASELINE,
      'oauth-2025-04-20,advisor-tool-2026-03-01',
    );

    const flags = new Set(value.split(','));
    expect(flags.has('claude-code-20250219')).toBe(true);
    expect(flags.has('oauth-2025-04-20')).toBe(true);
    expect(flags.has('advisor-tool-2026-03-01')).toBe(true);
    expect(stripped).toEqual([]);
  });

  test('passes context-1m through (OAuth + 1M is now confirmed working)', () => {
    // 2026-05-29: real CC v2.1.145 sends `context-1m-2025-08-07` over OAuth
    // and upstream returns 200 (verified by mitmproxy capture against a Pro
    // account). The earlier strip was a misdiagnosis caused by our URL
    // omitting `?beta=true`. Filter is now empty by default.
    const { value, stripped } = mergeAndFilterAnthropicBeta(
      BASELINE,
      'context-1m-2025-08-07,oauth-2025-04-20',
    );

    expect(value).toContain('context-1m-2025-08-07');
    expect(value).toContain('oauth-2025-04-20');
    expect(value).toContain('claude-code-20250219');
    expect(stripped).toEqual([]);
  });

  test('deduplicates when client repeats a baseline flag', () => {
    const { value } = mergeAndFilterAnthropicBeta(BASELINE, 'claude-code-20250219');

    const occurrences = value.split(',').filter((f) => f === 'claude-code-20250219');
    expect(occurrences.length).toBe(1);
  });

  test('tolerates whitespace and empty segments in the client value', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta(
      BASELINE,
      '  context-1m-2025-08-07 , , oauth-2025-04-20  ',
    );

    expect(value.split(',')).toContain('oauth-2025-04-20');
    expect(value.split(',')).toContain('context-1m-2025-08-07');
    expect(stripped).toEqual([]);
  });

  test('returns empty string when both inputs are empty', () => {
    const { value, stripped } = mergeAndFilterAnthropicBeta('', '');

    expect(value).toBe('');
    expect(stripped).toEqual([]);
  });
});

describe('createExtractedTemplate apply() — wrapper integration', () => {
  // Guards the seam between mergeAnthropicBeta (which logs) and
  // mergeAndFilterAnthropicBeta (the pure helper). If someone refactors and
  // forgets to call the helper, or wires clientHeaders wrong, only this test
  // catches it — the pure tests above pass even if the wrapper bypasses them.
  test('forwards context-1m through to upstream (OAuth + 1M works)', async () => {
    const template = createExtractedTemplate();
    const clientHeaders = new Headers({
      'anthropic-beta': 'context-1m-2025-08-07,oauth-2025-04-20',
    });

    const outbound = await template.apply({
      clientBody: { model: 'claude-opus-4-7', messages: [] },
      accessToken: 'sk-ant-test-token',
      clientHeaders,
    });

    const sentBeta = outbound.headers['anthropic-beta'] ?? '';
    expect(sentBeta).toContain('context-1m-2025-08-07');
    expect(sentBeta).toContain('oauth-2025-04-20');
  });

  test('URL includes ?beta=true (required for upstream beta-flag gating)', async () => {
    const template = createExtractedTemplate();
    const outbound = await template.apply({
      clientBody: { model: 'claude-sonnet-4-6', messages: [] },
      accessToken: 'sk-ant-test-token',
      clientHeaders: undefined,
    });
    expect(outbound.url).toContain('?beta=true');
  });
});

describe('resolveUserAgent — forward a NEWER Claude Code client UA, else replay the snapshot (#163)', () => {
  const SNAP = 'claude-cli/2.1.288 (external, sdk-cli)';

  test('forwards a newer claude-cli UA verbatim', () => {
    const h = new Headers({ 'user-agent': 'claude-cli/2.1.400 (external, cli)' });
    expect(resolveUserAgent(SNAP, h)).toBe('claude-cli/2.1.400 (external, cli)');
  });

  test('forwards a newer bare claude-cli/x.y.z with no suffix', () => {
    const h = new Headers({ 'user-agent': 'claude-cli/2.2.0' });
    expect(resolveUserAgent(SNAP, h)).toBe('claude-cli/2.2.0');
  });

  test('compares numerically, not lexically (2.1.1000 > 2.1.288, 10.0.0 > 2.1.288)', () => {
    expect(resolveUserAgent(SNAP, new Headers({ 'user-agent': 'claude-cli/2.1.1000' }))).toBe(
      'claude-cli/2.1.1000',
    );
    expect(resolveUserAgent(SNAP, new Headers({ 'user-agent': 'claude-cli/10.0.0' }))).toBe(
      'claude-cli/10.0.0',
    );
  });

  test('replays the snapshot when the client UA is OLDER or EQUAL — never worse than today', () => {
    for (const ua of [
      'claude-cli/2.1.126 (external, cli)',
      'claude-cli/0.0.1 (x)',
      'claude-cli/2.1.288 (external, cli)', // same version, different suffix → snapshot
    ]) {
      expect(resolveUserAgent(SNAP, new Headers({ 'user-agent': ua }))).toBe(SNAP);
    }
  });

  test('replays the snapshot for SDK-direct clients', () => {
    const h = new Headers({ 'user-agent': 'anthropic-sdk-python/0.40.0' });
    expect(resolveUserAgent(SNAP, h)).toBe(SNAP);
  });

  test('replays the snapshot when the header is absent or empty', () => {
    expect(resolveUserAgent(SNAP, undefined)).toBe(SNAP);
    expect(resolveUserAgent(SNAP, new Headers())).toBe(SNAP);
    expect(resolveUserAgent(SNAP, new Headers({ 'user-agent': '' }))).toBe(SNAP);
  });

  test('rejects claude-cli look-alikes and not-yet-seen shapes (pinned: change deliberately)', () => {
    for (const ua of [
      'claude-cli/abc (external, cli)',
      'claude-cli/2.1 (external, cli)',
      'claude-cli/2.1.300.1 (external, cli)', // 4-segment
      'claude-cli/2.2.0-beta.1 (external, cli)', // pre-release tag
      'claude-cli/2.1.300 (external, cli) extra', // trailing text
      // trailing whitespace is not listed: the Fetch `Headers` API trims it,
      // so a padded-but-valid UA arrives clean and is (correctly) forwarded.
      'claude-cli/2.1.300 (a) (b)', // two parentheticals
      'claude-cli/2.1.300 (extérnal, cli)', // non-ASCII (Latin-1) in suffix
      // non-Latin-1 (e.g. U+2028) is not listed: the Fetch `Headers` API
      // rejects non-ByteString values before they can reach resolveUserAgent.
      'claude-cli/2.1.300 (\tcli)', // control char in suffix
      'claude-cli/99999.0.0', // >4 digits
      'not-claude-cli/2.1.300 (external, cli)',
      'Mozilla/5.0 claude-cli/2.1.300',
      // CRLF injection is not listed: the Fetch `Headers` constructor already
      // rejects such values before they can reach resolveUserAgent.
    ]) {
      expect(resolveUserAgent(SNAP, new Headers({ 'user-agent': ua }))).toBe(SNAP);
    }
  });

  test('caps an absurdly long UA to the snapshot value', () => {
    const h = new Headers({ 'user-agent': `claude-cli/2.1.400 (${'x'.repeat(600)})` });
    expect(resolveUserAgent(SNAP, h)).toBe(SNAP);
  });

  test('forwards a well-formed client UA when the snapshot UA itself is unparseable', () => {
    const h = new Headers({ 'user-agent': 'claude-cli/2.1.400 (external, cli)' });
    expect(resolveUserAgent('hand-edited-garbage', h)).toBe('claude-cli/2.1.400 (external, cli)');
  });
});

describe('createExtractedTemplate apply() — user-agent forwarding (#163)', () => {
  test('a newer Claude Code client\'s UA reaches upstream instead of the snapshot\'s', async () => {
    const template = createExtractedTemplate();
    const outbound = await template.apply({
      clientBody: { model: 'claude-opus-5-5', messages: [] },
      accessToken: 'sk-ant-test-token',
      clientHeaders: new Headers({ 'user-agent': 'claude-cli/99.0.0 (external, cli)' }),
    });
    expect(outbound.headers['user-agent']).toBe('claude-cli/99.0.0 (external, cli)');
  });

  test('an SDK-direct client still gets the snapshot UA', async () => {
    expect(SNAPSHOT_UA).toBeString();
    const template = createExtractedTemplate();
    const outbound = await template.apply({
      clientBody: { model: 'claude-opus-5-5', messages: [] },
      accessToken: 'sk-ant-test-token',
      clientHeaders: new Headers({ 'user-agent': 'anthropic-sdk-typescript/0.50.0' }),
    });
    expect(outbound.headers['user-agent']).toBe(SNAPSHOT_UA);
  });

  test('user-agent keeps its snapshot slot in the outbound header order', async () => {
    const template = createExtractedTemplate();
    const outbound = await template.apply({
      clientBody: { model: 'claude-opus-5-5', messages: [] },
      accessToken: 'sk-ant-test-token',
      clientHeaders: new Headers({ 'user-agent': 'claude-cli/99.0.0 (external, cli)' }),
    });
    const sentOrder = Object.keys(outbound.headers);
    const snapOrder = (snapshot.headerOrder as string[]).filter((n) => sentOrder.includes(n));
    expect(sentOrder.indexOf('user-agent')).toBe(snapOrder.indexOf('user-agent'));
  });

  test('a snapshot without user-agent emits no empty header, but still forwards a newer client UA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfy-snap-'));
    const stripped = {
      ...snapshot,
      headerOrder: (snapshot.headerOrder as string[]).filter((n) => n !== 'user-agent'),
      headerValues: (snapshot.headerValues as Array<{ name: string; value: string }>).filter(
        (h) => h.name !== 'user-agent',
      ),
    };
    const path = join(dir, 'snap.json');
    writeFileSync(path, JSON.stringify(stripped));
    try {
      const template = createExtractedTemplate({ snapshotPath: path });
      const plain = await template.apply({
        clientBody: { model: 'claude-opus-5-5', messages: [] },
        accessToken: 'sk-ant-test-token',
        clientHeaders: undefined,
      });
      expect('user-agent' in plain.headers).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveUserAgent — warns once when the client is a minor/major ahead of the snapshot (re-capture signal, #163)', () => {
  const SNAP = 'claude-cli/2.1.288 (external, sdk-cli)';
  const warns: string[] = [];
  const capturing: Logger = {
    debug: () => {},
    info: () => {},
    warn: (m) => {
      warns.push(m);
    },
    error: () => {},
  };
  const restore = (): void => setLogger(createLogger({ level: 'info', pretty: true }));

  test('patch-only skew forwards silently', () => {
    setLogger(capturing);
    try {
      warns.length = 0;
      resolveUserAgent(SNAP, new Headers({ 'user-agent': 'claude-cli/2.1.900 (external, cli)' }));
      expect(warns.filter((w) => w.includes('behind'))).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test('minor skew forwards AND warns once per (snapshot, client) major.minor pair', () => {
    setLogger(capturing);
    try {
      warns.length = 0;
      const a = resolveUserAgent(SNAP, new Headers({ 'user-agent': 'claude-cli/2.7.0 (external, cli)' }));
      const b = resolveUserAgent(SNAP, new Headers({ 'user-agent': 'claude-cli/2.7.3 (external, cli)' }));
      expect(a).toBe('claude-cli/2.7.0 (external, cli)');
      expect(b).toBe('claude-cli/2.7.3 (external, cli)');
      const behind = warns.filter((w) => w.includes('behind'));
      expect(behind).toHaveLength(1);
      expect(behind[0]).toContain('2.1');
      expect(behind[0]).toContain('2.7');
      expect(behind[0]).toContain('re-capture');
    } finally {
      restore();
    }
  });

  test('major skew warns on its own key', () => {
    setLogger(capturing);
    try {
      warns.length = 0;
      resolveUserAgent(SNAP, new Headers({ 'user-agent': 'claude-cli/3.0.0 (external, cli)' }));
      expect(warns.filter((w) => w.includes('behind') && w.includes('3.0'))).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
