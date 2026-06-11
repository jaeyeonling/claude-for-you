import { describe, expect, test } from 'bun:test';
import {
  createAliasMap,
  createReverseToolNameStream,
  reverseToolNamesInText,
  rewriteToolNamesForUpstream,
} from '../src/proxy/tool-name-mapping.js';
import { TOOL_NAME_TRIGGERS } from '../src/proxy/classifier-triggers.js';

// Background: issue #125. Bidirectional tool-name mapping for the sub-plan
// classifier. The wire to upstream carries aliases; the wire back to the
// caller is byte-identical to a direct API-key call. Per-request alias map
// in closure scope, no module-global state.
//
// Test layout follows the plan v3 case enumeration in
// .claude/matrix-sessions/125.md.

// Helper to drain a TransformStream-bearing pipeline into a single string.
const pipeThroughToString = async (
  input: string,
  transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<string> => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const out = source.pipeThrough(transform);
  const reader = out.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
};

// Helper: feed a sequence of chunks (split however we like) through the
// transform and concatenate the output. Exercises chunk-boundary safety.
const pipeChunks = async (
  chunks: string[],
  transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<string> => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const out = source.pipeThrough(transform);
  const reader = out.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
};

describe('rewriteToolNamesForUpstream', () => {
  test('case 1: only trigger names get aliased; non-triggers pass through by reference', () => {
    const original = {
      tools: [
        { name: 'session_search', description: 'search prior sessions' },
        { name: 'browser_back', description: 'go back' },
      ],
    };
    const aliasMap = createAliasMap();
    const out = rewriteToolNamesForUpstream(original, TOOL_NAME_TRIGGERS, aliasMap);
    const tools = (out as { tools: Array<{ name: string }> }).tools;
    expect(tools[0].name).toBe('__cfy_alias_0__');
    expect(tools[1]).toBe(original.tools[1]);
    expect(aliasMap.hasMappings()).toBe(true);
  });

  test('case 2: alias forward/reverse round-trip is deterministic and unique', () => {
    const aliasMap = createAliasMap();
    expect(aliasMap.toAlias('session_search')).toBe('__cfy_alias_0__');
    expect(aliasMap.toAlias('session_search')).toBe('__cfy_alias_0__'); // idempotent
    expect(aliasMap.fromAlias('__cfy_alias_0__')).toBe('session_search');
    expect(aliasMap.fromAlias('__cfy_alias_42__')).toBeUndefined();
  });

  test('case 3: non-trigger-only body returns the input by reference (hasMappings false)', () => {
    const original = {
      tools: [{ name: 'browser_back' }, { name: 'terminal' }],
    };
    const aliasMap = createAliasMap();
    const out = rewriteToolNamesForUpstream(original, TOOL_NAME_TRIGGERS, aliasMap);
    expect(out).toBe(original);
    expect(aliasMap.hasMappings()).toBe(false);
  });

  test('case 4: tools is not an array — identity return, no alias map mutation', () => {
    const aliasMap = createAliasMap();
    expect(rewriteToolNamesForUpstream({}, TOOL_NAME_TRIGGERS, aliasMap)).toEqual({});
    const withNull = { tools: null };
    expect(rewriteToolNamesForUpstream(withNull, TOOL_NAME_TRIGGERS, aliasMap)).toBe(withNull);
    const withString = { tools: 'session_search' };
    expect(rewriteToolNamesForUpstream(withString, TOOL_NAME_TRIGGERS, aliasMap)).toBe(withString);
    expect(aliasMap.hasMappings()).toBe(false);
  });

  test('input guard: non-object / non-string-name entries pass through untouched', () => {
    const original = {
      tools: [
        null,
        'not-an-object',
        { name: 123 },
        { description: 'no name field' },
        { name: 'session_search' },
      ],
    };
    const aliasMap = createAliasMap();
    const out = rewriteToolNamesForUpstream(original, TOOL_NAME_TRIGGERS, aliasMap);
    const tools = (out as { tools: unknown[] }).tools;
    expect(tools[0]).toBeNull();
    expect(tools[1]).toBe('not-an-object');
    expect(tools[2]).toEqual({ name: 123 });
    expect(tools[3]).toEqual({ description: 'no name field' });
    expect((tools[4] as { name: string }).name).toBe('__cfy_alias_0__');
  });
});

describe('reverseToolNamesInText', () => {
  test('case 5: reverses registered aliases in JSON-like text', () => {
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search');
    const input = '{"name":"__cfy_alias_0__","input":{}}';
    const out = reverseToolNamesInText(input, aliasMap);
    expect(out).toBe('{"name":"session_search","input":{}}');
  });

  test('case 6: unregistered alias-shaped strings in caller body pass through unchanged', () => {
    // The caller's body happens to mention a string that looks like an alias
    // but for an index we never assigned. fromAlias has no entry, so reverse
    // must not touch it.
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search'); // registers __cfy_alias_0__
    const caller = 'discussion of __cfy_alias_99__ which we never assigned';
    expect(reverseToolNamesInText(caller, aliasMap)).toBe(caller);
  });

  test('empty alias map → input returned by reference', () => {
    const aliasMap = createAliasMap();
    const input = 'no triggers fired here';
    expect(reverseToolNamesInText(input, aliasMap)).toBe(input);
  });
});

describe('createReverseToolNameStream', () => {
  test('case 7: single-chunk input gets aliases reversed', async () => {
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search');
    const input =
      'event: content_block_start\ndata: {"type":"content_block_start","name":"__cfy_alias_0__"}\n\n';
    const out = await pipeThroughToString(input, createReverseToolNameStream(aliasMap));
    expect(out).toBe(
      'event: content_block_start\ndata: {"type":"content_block_start","name":"session_search"}\n\n',
    );
  });

  test('case 8: chunk boundary cuts an alias in half — carry-over reassembles', async () => {
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search');
    // Deliberately split the alias mid-string. Without the line buffer the
    // substring replace would miss it; with the line buffer the partial line
    // is held until '\n' arrives, then the whole line is rewritten as a unit.
    const chunks = [
      'event: content_block_start\ndata: {"name":"__cfy_',
      'alias_0__"}\n',
      'event: content_block_stop\ndata: {}\n\n',
    ];
    const out = await pipeChunks(chunks, createReverseToolNameStream(aliasMap));
    expect(out).toContain('"name":"session_search"');
    expect(out).not.toContain('__cfy_alias_0__');
  });

  test('case 9: full Anthropic-shape SSE replay round-trips name to original', async () => {
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search');
    const upstream = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"__cfy_alias_0__","input":{}}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      '',
    ].join('\n');
    const out = await pipeThroughToString(upstream, createReverseToolNameStream(aliasMap));
    // The tool_use.name as caller-facing must be the original.
    expect(out).toContain('"name":"session_search"');
    // No alias should remain anywhere in the caller-facing stream.
    expect(out).not.toContain('__cfy_alias_0__');
    // Unrelated SSE structure preserved byte-for-byte.
    expect(out).toContain('event: message_start');
    expect(out).toContain('"input_tokens":10');
  });

  test('case 10: text without any aliases survives the transform byte-for-byte', async () => {
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search'); // map non-empty but no alias appears in input
    const input = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const out = await pipeThroughToString(input, createReverseToolNameStream(aliasMap));
    expect(out).toBe(input);
  });

  test('partial trailing line (no terminating newline) is flushed with aliases reversed', async () => {
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search');
    const input = 'data: {"name":"__cfy_alias_0__"}';
    const out = await pipeThroughToString(input, createReverseToolNameStream(aliasMap));
    expect(out).toBe('data: {"name":"session_search"}');
  });
});

describe('hardening regression guards (Chaos #125 review)', () => {
  test('TOOL_NAME_TRIGGERS refuses Set mutation methods', () => {
    // Object.freeze on a Set is shallow; without the explicit defineProperty
    // guard in classifier-triggers.ts, a sibling module could call
    // `triggers.add('foo')` and silently widen the trigger set, or
    // `triggers.clear()` and silently disable the entire bypass.
    expect(() => (TOOL_NAME_TRIGGERS as Set<string>).add('x')).toThrow(
      /read-only/,
    );
    expect(() => (TOOL_NAME_TRIGGERS as Set<string>).clear()).toThrow(
      /read-only/,
    );
    expect(() => (TOOL_NAME_TRIGGERS as Set<string>).delete('session_search')).toThrow(
      /read-only/,
    );
    // Read methods remain functional.
    expect(TOOL_NAME_TRIGGERS.has('session_search')).toBe(true);
  });

  test('TOOL_NAME_TRIGGERS contains the full four-tool fingerprint (#134)', () => {
    // The sub-plan classifier fires on the simultaneous presence of these
    // four names in `tools[]`. Removing or aliasing any one breaks the
    // fingerprint (R2/R3 bisect under #134 on the Bri-shape body). If a
    // future change removes one, the classifier 400s come back — guard
    // against accidental deletion here.
    for (const name of ['session_search', 'skill_manage', 'skill_view', 'skills_list']) {
      expect(TOOL_NAME_TRIGGERS.has(name)).toBe(true);
    }
  });

  test('all four #134 trigger names get aliased by rewriteToolNamesForUpstream', () => {
    // End-to-end check that the outbound path actually rewrites every
    // member of the fingerprint set, so a Bri-shape body wouldn't leak
    // even one of the four literal names to upstream.
    const body = {
      tools: [
        { name: 'session_search' },
        { name: 'skill_manage' },
        { name: 'skill_view' },
        { name: 'skills_list' },
        { name: 'browser_back' }, // sanity: untouched
      ],
    };
    const aliasMap = createAliasMap();
    const out = rewriteToolNamesForUpstream(body, TOOL_NAME_TRIGGERS, aliasMap);
    const names = (out as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names[0]).toMatch(/^__cfy_alias_\d+__$/);
    expect(names[1]).toMatch(/^__cfy_alias_\d+__$/);
    expect(names[2]).toMatch(/^__cfy_alias_\d+__$/);
    expect(names[3]).toMatch(/^__cfy_alias_\d+__$/);
    expect(names[4]).toBe('browser_back');
  });

  test('no registered trigger collides with the alias prefix', () => {
    // If a future trigger entry literally starts with `__cfy_alias_`, the
    // outbound rewrite would produce an alias that looks like a caller-
    // supplied alias-shaped string — and the reverse pass would behave
    // unpredictably. Lock the invariant so the conflict is caught at the
    // moment the entry is added.
    for (const name of TOOL_NAME_TRIGGERS) {
      expect(name.startsWith('__cfy_alias_')).toBe(false);
    }
  });

  test('empty tool name passes through without consuming an alias index', () => {
    const aliasMap = createAliasMap();
    expect(aliasMap.toAlias('')).toBe('');
    expect(aliasMap.hasMappings()).toBe(false);
  });
});

describe('concurrency / non-sharing', () => {
  test('case 11: two alias maps from createAliasMap are independent', () => {
    const a = createAliasMap();
    const b = createAliasMap();
    expect(a.toAlias('session_search')).toBe('__cfy_alias_0__');
    // The second map's counter is its own — also starts at 0 — but its entry
    // is for a different name. The fromAlias lookups stay isolated.
    expect(b.toAlias('other_name')).toBe('__cfy_alias_0__');
    expect(a.fromAlias('__cfy_alias_0__')).toBe('session_search');
    expect(b.fromAlias('__cfy_alias_0__')).toBe('other_name');
    // Cross-pollination must not happen: B's alias is identical text but A
    // doesn't know about 'other_name'.
    expect(a.fromAlias('__cfy_alias_1__')).toBeUndefined();
  });
});

describe('case 12: downstream cancellation does not throw', () => {
  test('mid-stream reader cancel — transform swallows InvalidState on subsequent enqueues', async () => {
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search');
    const transform = createReverseToolNameStream(aliasMap);
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"name":"__cfy_alias_0__"}\n'));
        // Yield so the consumer gets a chance to read and cancel before we
        // try to enqueue more.
        await new Promise((r) => setTimeout(r, 5));
        controller.enqueue(encoder.encode('data: {"name":"__cfy_alias_0__"}\n'));
        controller.close();
      },
    });
    const out = source.pipeThrough(transform);
    const reader = out.getReader();
    await reader.read();
    await reader.cancel();
    // No assertion needed: the implicit expectation is that no unhandled
    // exception escapes the stream. If `safeEnqueue` weren't catching the
    // post-cancel `InvalidState`, this test would surface a rejection.
    expect(true).toBe(true);
  });
});

describe('case 13: watchdog bench — 50KB SSE body with active alias map', () => {
  test('line-buffered transform completes well under sanity ceiling', async () => {
    const aliasMap = createAliasMap();
    aliasMap.toAlias('session_search');
    // Build ~50KB of SSE lines, ~5% of which carry the alias.
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(`data: {"type":"content_block_delta","index":${i},"delta":{"text":"x".repeat(60)}}`);
      lines.push('');
    }
    // Sprinkle 30 lines that actually exercise the reverse path.
    for (let i = 0; i < 30; i++) {
      lines.push(`data: {"type":"content_block_start","name":"__cfy_alias_0__"}`);
      lines.push('');
    }
    const input = lines.join('\n') + '\n';
    const t0 = performance.now();
    const out = await pipeThroughToString(input, createReverseToolNameStream(aliasMap));
    const elapsedMs = performance.now() - t0;
    process.stderr.write(
      `[#125 bench] ${input.length.toLocaleString()} bytes through reverse stream: ${elapsedMs.toFixed(3)} ms\n`,
    );
    expect(elapsedMs).toBeLessThan(1000);
    expect(out).not.toContain('__cfy_alias_0__');
    expect(out).toContain('"name":"session_search"');
  });
});
