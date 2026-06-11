/**
 * Bidirectional tool-name mapping for the sub-plan classifier (#125).
 *
 * Why this exists:
 *   The sub-plan classifier reads inbound `tools[].name` as part of a set
 *   fingerprint. Some names co-occurring with a non-CC tool set trip the
 *   classifier into the overage lane (HTTP 400 "out of extra usage" — see
 *   #123 for the diagnosis). Renaming the offending name outbound passes the
 *   classifier, but the caller's SDK still expects to see the original name
 *   in `tool_use.name` events on the response — anything else breaks their
 *   tool-handler dispatch. So we need both: rewrite outbound, reverse on
 *   the response path.
 *
 * Asymmetry policy (intentional, see #125 plan retro):
 *   - The wire to upstream carries aliases.
 *   - The wire back to the caller is byte-identical to a direct API-key call
 *     (alias → original at SSE-line / JSON-body granularity).
 *   - `messages_log` records the upstream-facing wire form (aliases intact).
 *     This means admin UI shows aliases by default; resolving them in the
 *     admin UI is tracked separately as #131.
 *
 * State scope:
 *   The alias map is **per-request** — created at the top of the handler,
 *   captured by the response-transform closure, discarded when the request
 *   completes. No module-global state, so concurrent requests on the same
 *   process cannot leak alias indices into each other.
 *
 * Alias format:
 *   `__cfy_alias_{idx}__` — the leading `__cfy_alias_` is a unique prefix
 *   chosen to make accidental collisions with caller-supplied text effectively
 *   impossible. The trailing `__` is a closing guard so substring matching
 *   doesn't snag on prefix-only collisions like a hypothetical caller name
 *   `__cfy_alias_X_extra`. The reverse pass only rewrites aliases that were
 *   actually registered for this request — so even if the caller's body
 *   contained an unrelated `__cfy_alias_99__` string, it wouldn't be touched
 *   unless index 99 was assigned during this request's outbound pass.
 */

const ALIAS_PREFIX = '__cfy_alias_';
const ALIAS_SUFFIX = '__';

export interface ToolAliasMap {
  /** Look up the outbound alias for `name`, creating one if this is the first
   * time we've seen it. Idempotent for the same input within one request:
   * `toAlias('X')` returns the same alias on every call. */
  toAlias(name: string): string;
  /** Reverse lookup. Returns `undefined` for any alias not registered through
   * `toAlias` in this request — including syntactically-similar strings that
   * happened to slip through the caller's body. */
  fromAlias(alias: string): string | undefined;
  /** Cheap check: are there any mappings to reverse? Used by callers to skip
   * the entire response-transform chain when no triggers fired. */
  hasMappings(): boolean;
  /** Iterate the registered aliases (for the response transform). The order
   * matters when a future alias literally contains another — currently the
   * single-token prefix design rules that out, but we keep it deterministic
   * (insertion order) so the contract doesn't drift if a future entry adds
   * substring relationships. */
  forEachAlias(fn: (alias: string, original: string) => void): void;
}

export const createAliasMap = (): ToolAliasMap => {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  return {
    toAlias(name: string): string {
      // Empty-name guard: Anthropic's contract requires non-empty `name`, and
      // an empty trigger would alias to `__cfy_alias_0__` and then reverse to
      // an empty string in caller-facing responses (Chaos #125 review).
      // Treat empty as pass-through — let Anthropic return its own 400.
      if (name === '') return name;
      const existing = forward.get(name);
      if (existing !== undefined) return existing;
      const alias = `${ALIAS_PREFIX}${forward.size}${ALIAS_SUFFIX}`;
      forward.set(name, alias);
      reverse.set(alias, name);
      return alias;
    },
    fromAlias(alias: string): string | undefined {
      return reverse.get(alias);
    },
    hasMappings(): boolean {
      return forward.size > 0;
    },
    forEachAlias(fn) {
      for (const [alias, original] of reverse) fn(alias, original);
    },
  };
};

/**
 * Outbound: rewrite `body.tools[i].name` for any tool whose name appears in
 * `triggers`. Registers each rewrite in `aliasMap` so the response side can
 * reverse it.
 *
 * Returns a new object only if a rewrite actually happened — when no triggers
 * matched the input is returned by reference. This keeps the GC pressure on
 * the happy path at zero (the vast majority of requests carry no trigger).
 *
 * Defensive input handling: a body with no `tools`, with `tools` that is not
 * an array, with non-object tool entries, or with non-string `name` fields,
 * passes through unchanged. The proxy boundary doesn't try to validate
 * Anthropic's request schema — bad shapes flow to upstream and Anthropic
 * returns its own 400.
 */
export const rewriteToolNamesForUpstream = (
  body: Record<string, unknown>,
  triggers: ReadonlySet<string>,
  aliasMap: ToolAliasMap,
): Record<string, unknown> => {
  const tools = body.tools;
  if (!Array.isArray(tools)) return body;
  let rewritten: unknown[] | null = null;
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (tool === null || typeof tool !== 'object') continue;
    const t = tool as Record<string, unknown>;
    if (typeof t.name !== 'string') continue;
    if (!triggers.has(t.name)) continue;
    if (rewritten === null) rewritten = tools.slice();
    rewritten[i] = { ...t, name: aliasMap.toAlias(t.name) };
  }
  if (rewritten === null) return body;
  return { ...body, tools: rewritten };
};

/**
 * Reverse aliases in a piece of text (a JSON body or a buffered SSE line).
 *
 * Identity-preserving when the alias map is empty — returns the input string
 * reference. Otherwise applies a `split(alias).join(original)` for each
 * registered alias. Each alias is a literal substring, so no regex backtracking
 * surface; and because only registered aliases are reversed, an accidental
 * `__cfy_alias_X__` literal in the caller's body (for some unregistered X)
 * passes through untouched.
 */
export const reverseToolNamesInText = (text: string, aliasMap: ToolAliasMap): string => {
  if (!aliasMap.hasMappings()) return text;
  let out = text;
  aliasMap.forEachAlias((alias, original) => {
    if (out.includes(alias)) {
      out = out.split(alias).join(original);
    }
  });
  return out;
};

/**
 * Streaming reverse: a TransformStream that line-buffers the upstream SSE
 * bytes, applies `reverseToolNamesInText` once per complete line, and emits
 * the rewritten line downstream.
 *
 * Anthropic's SSE uses `\n` as the line separator (and `\n\n` as the event
 * separator — see `src/usage/sniff.ts`). `tool_use.name` is always in the
 * `data:` line's JSON within a single `\n`-delimited line, so a line-buffered
 * transform sees every alias whole. The trailing partial line (no `\n` yet)
 * is held in the buffer and emitted on the next chunk or on `flush`.
 *
 * `\r\n` is not supported — Anthropic's wire format has used `\n`-only line
 * endings since the beginning of this proxy's history. If that ever changes,
 * `sniff.ts` will also need to be retrofit.
 *
 * `downstreamOpen` guard mirrors `sniff.ts`: when the proxy client cancels
 * mid-stream, Bun throws `InvalidState: Controller is already closed` from
 * `enqueue`/`close`. We swallow it so the upstream drain can complete and
 * `tap.done` resolves normally.
 */
export const createReverseToolNameStream = (
  aliasMap: ToolAliasMap,
): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder('utf-8');
  const encoder = new TextEncoder();
  let buffer = '';
  let downstreamOpen = true;
  const safeEnqueue = (
    controller: TransformStreamDefaultController<Uint8Array>,
    text: string,
  ): void => {
    if (!downstreamOpen) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      downstreamOpen = false;
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        safeEnqueue(controller, reverseToolNamesInText(line, aliasMap));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        safeEnqueue(controller, reverseToolNamesInText(buffer, aliasMap));
        buffer = '';
      }
    },
  });
};
