import { describe, expect, test } from "bun:test";
import {
  createNullMessageLogStore,
  extractModel,
  extractPreview,
  extractResponseMeta,
  sanitizeJsonValue,
} from "../src/usage/messages-log.js";

describe("extractPreview", () => {
  test("returns string content of the last user message", () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "response" },
        { role: "user", content: "second user message" },
      ],
    };
    expect(extractPreview(body)).toBe("second user message");
  });

  test("returns text-block content when content is an array", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ignored" },
            { type: "text", text: "real prompt here" },
          ],
        },
      ],
    };
    expect(extractPreview(body)).toBe("real prompt here");
  });

  test("truncates to the configured max length", () => {
    const body = { messages: [{ role: "user", content: "a".repeat(500) }] };
    expect(extractPreview(body, 10)).toBe("aaaaaaaaaa");
  });

  test("returns empty string when no user messages present", () => {
    expect(
      extractPreview({ messages: [{ role: "assistant", content: "x" }] }),
    ).toBe("");
    expect(extractPreview({})).toBe("");
    expect(extractPreview(null)).toBe("");
    expect(extractPreview("not an object")).toBe("");
  });
});

describe("extractModel", () => {
  test("reads top-level model string", () => {
    expect(extractModel({ model: "claude-sonnet-4-6" })).toBe(
      "claude-sonnet-4-6",
    );
  });

  test("returns null for non-string or missing model", () => {
    expect(extractModel({ model: 42 })).toBeNull();
    expect(extractModel({})).toBeNull();
    expect(extractModel(null)).toBeNull();
  });
});

describe("extractResponseMeta", () => {
  test("extracts token + tier + stop_reason from non-streaming JSON", () => {
    const meta = extractResponseMeta({
      kind: "json",
      body: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
          service_tier: "standard",
        },
        stop_reason: "end_turn",
      },
    });
    expect(meta.inputTokens).toBe(100);
    expect(meta.outputTokens).toBe(50);
    expect(meta.cacheReadTokens).toBe(30);
    expect(meta.cacheCreationTokens).toBe(10);
    expect(meta.serviceTier).toBe("standard");
    expect(meta.stopReason).toBe("end_turn");
  });

  test("walks SSE data: lines and takes the max token count", () => {
    // message_start carries initial usage with cache fields; message_delta
    // updates output_tokens as the assistant streams; delta.stop_reason
    // arrives in the final message_delta event.
    const raw = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 1, cache_read_input_tokens: 50, service_tier: "standard" } } })}`,
      ``,
      `event: message_delta`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 45 }, delta: { stop_reason: "end_turn" } })}`,
      ``,
    ].join("\n");
    const meta = extractResponseMeta({ kind: "sse", raw });
    expect(meta.inputTokens).toBe(200);
    expect(meta.outputTokens).toBe(45);
    expect(meta.cacheReadTokens).toBe(50);
    expect(meta.stopReason).toBe("end_turn");
    expect(meta.serviceTier).toBe("standard");
  });

  test("returns zero meta for null body", () => {
    const meta = extractResponseMeta(null);
    expect(meta.inputTokens).toBe(0);
    expect(meta.stopReason).toBeNull();
  });

  test("returns zero meta for opaque text body", () => {
    const meta = extractResponseMeta({ kind: "text", raw: "rate_limit_error" });
    expect(meta.inputTokens).toBe(0);
    expect(meta.stopReason).toBeNull();
  });

  test("tolerates malformed SSE lines", () => {
    const raw = 'data: not-json\n\ndata: {"type":"x"}\n\n';
    const meta = extractResponseMeta({ kind: "sse", raw });
    expect(meta.inputTokens).toBe(0);
  });
});

describe("sanitizeJsonValue", () => {
  const NUL = "\u0000";
  const FFFD = "\uFFFD";

  test("replaces NUL in a top-level string", () => {
    expect(sanitizeJsonValue(`a${NUL}b`)).toBe(`a${FFFD}b`);
  });

  test("passes primitives through unchanged", () => {
    expect(sanitizeJsonValue(42)).toBe(42);
    expect(sanitizeJsonValue(true)).toBe(true);
    expect(sanitizeJsonValue(null)).toBeNull();
    expect(sanitizeJsonValue(undefined)).toBeUndefined();
  });

  test("walks nested objects and replaces in deep string values", () => {
    const input = {
      messages: [
        { role: "user", content: `before${NUL}after` },
        { role: "assistant", content: [{ type: "text", text: `x${NUL}y` }] },
      ],
    };
    const out = sanitizeJsonValue(input) as typeof input;
    expect(out.messages[0]!.content).toBe(`before${FFFD}after`);
    expect((out.messages[1]!.content as Array<{ text: string }>)[0]!.text).toBe(
      `x${FFFD}y`,
    );
  });

  test("replaces NUL in object keys", () => {
    const input = { [`bad${NUL}key`]: "value" };
    const out = sanitizeJsonValue(input) as Record<string, string>;
    expect(Object.keys(out)).toEqual([`bad${FFFD}key`]);
    expect(out[`bad${FFFD}key`]).toBe("value");
  });

  test("does not mutate the input", () => {
    const input = { msg: `a${NUL}b`, list: [`c${NUL}d`] };
    const snapshot = structuredClone(input);
    sanitizeJsonValue(input);
    expect(input).toEqual(snapshot);
  });

  test("returns the same string reference when no NUL present (fast path)", () => {
    // Hot-path optimization: NUL-free strings should not allocate a new copy.
    // Verifies the indexOf guard short-circuits replaceAll.
    const s = "no-NUL-here";
    expect(sanitizeJsonValue(s)).toBe(s);
  });

  test("returns a sentinel when nesting exceeds the depth limit", () => {
    // Build a 1100-deep object. Limit is 1024, so the inner leaves become
    // the sentinel string rather than triggering a stack overflow.
    let nested: unknown = "leaf";
    for (let i = 0; i < 1100; i++) nested = { a: nested };
    const out = sanitizeJsonValue(nested);
    expect(JSON.stringify(out)).toContain(
      "[messages-log: depth limit reached]",
    );
  });

  test("drops prototype-pollution keys (__proto__, constructor, prototype)", () => {
    // JSON.parse is the only way to create an *own* `__proto__` property —
    // matches the real attack vector where adversarial JSON enters via
    // `c.req.json()` in the proxy. Object literals would set the prototype
    // instead, which Object.entries() never enumerates.
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"hijacked":true},"prototype":{"x":1},"safe":"kept"}',
    );
    const out = sanitizeJsonValue(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["safe"]);
    expect(out.safe).toBe("kept");
  });

  test("sanitizes the SSE raw envelope", () => {
    const rb = { kind: "sse" as const, raw: `data: ${NUL}\n\n` };
    const out = sanitizeJsonValue(rb) as { kind: string; raw: string };
    expect(out.kind).toBe("sse");
    expect(out.raw).toBe(`data: ${FFFD}\n\n`);
  });

  test("sanitizes the json kind envelope (body is unknown)", () => {
    const rb = { kind: "json" as const, body: { text: `oops${NUL}` } };
    const out = sanitizeJsonValue(rb) as {
      kind: string;
      body: { text: string };
    };
    expect(out.body.text).toBe(`oops${FFFD}`);
  });

  test("preserves array order and shape", () => {
    const out = sanitizeJsonValue([
      1,
      `a${NUL}`,
      { k: `b${NUL}` },
      null,
    ]) as unknown[];
    expect(out).toEqual([1, `a${FFFD}`, { k: `b${FFFD}` }, null]);
    expect(Array.isArray(out)).toBe(true);
  });

  test("depth boundary: depth <= MAX (1024) passes through, depth > MAX hits sentinel", () => {
    // Boundary is `depth > MAX_SANITIZE_DEPTH`. Build trees of exact depth so a
    // future change from `>` to `>=` (or vice versa) trips this test.
    const buildNest = (n: number): unknown => {
      let nested: unknown = "leaf";
      for (let i = 0; i < n; i++) nested = { a: nested };
      return nested;
    };
    // depth=1024 → passes through, leaf preserved
    const at = sanitizeJsonValue(buildNest(1024));
    expect(JSON.stringify(at)).toContain('"leaf"');
    expect(JSON.stringify(at)).not.toContain("depth limit reached");

    // depth=1025 → sentinel appears at the deepest level
    const over = sanitizeJsonValue(buildNest(1025));
    expect(JSON.stringify(over)).toContain(
      "[messages-log: depth limit reached]",
    );
  });

  test("empty containers pass through unchanged", () => {
    expect(sanitizeJsonValue({})).toEqual({});
    expect(sanitizeJsonValue([])).toEqual([]);
    expect(sanitizeJsonValue("")).toBe("");
  });

  test("drops legacy accessor keys (__lookupGetter__ etc.)", () => {
    const input = JSON.parse(
      '{"__lookupGetter__":{"x":1},"__defineSetter__":{"y":2},"safe":"kept"}',
    );
    const out = sanitizeJsonValue(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["safe"]);
  });
});

describe("createNullMessageLogStore", () => {
  test("record is a no-op and list returns empty", async () => {
    const store = createNullMessageLogStore();
    await store.record({
      id: "x",
      ts: new Date(),
      userName: "u",
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
    expect(await store.get("x")).toBeNull();
  });
});
