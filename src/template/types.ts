/**
 * ClaudeTemplate — the abstraction that makes an outbound request look like
 * one Claude Code would send. Today (B): a static header snapshot is enough.
 * Tomorrow (C): a live template extracted from the user's installed CC binary
 * should slot in behind the same interface without touching proxy/messages.ts.
 *
 * The OAuth bearer is NOT part of the template — it's per-request and gets
 * injected at apply-time by the caller. The template owns *identity shape*,
 * not *authentication*.
 */

export type TemplateSource = 'static' | 'extracted';

export type OutboundRequest = Readonly<{
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}>;

export type ApplyInput = Readonly<{
  /** Raw client-supplied JSON body (Anthropic Messages API shape). */
  clientBody: unknown;
  /** Fresh OAuth access token, injected per-request. */
  accessToken: string;
  /**
   * Incoming request headers. When non-undefined, the template may merge
   * client-controlled fields (e.g. anthropic-beta) — the client is then
   * responsible for matching body shape to whatever flags it activates.
   */
  clientHeaders: Headers | undefined;
}>;

export interface ClaudeTemplate {
  readonly source: TemplateSource;
  readonly description: string;
  apply(input: ApplyInput): Promise<OutboundRequest>;
}
