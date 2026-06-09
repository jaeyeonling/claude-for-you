/**
 * Headers that callers MUST NOT supply via DomainError.headers — the onError
 * handler strips these defensively so a misused factory can't break HTTP
 * framing or leak credentials. Covers:
 *   - hop-by-hop (RFC 7230 §6.1)
 *   - body framing (Hono/Bun compute these from the body)
 *   - sensitive response headers (set-cookie, authorization echo, etc.)
 *
 * If you really need to set one of these, do it directly on the Response in
 * the route handler — not through a thrown error.
 */
export const FORBIDDEN_ERROR_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  'set-cookie',
  'authorization',
]);

export class DomainError extends Error {
  /** Optional response headers — set by error factories that need to convey
   * protocol-level metadata (e.g. Retry-After on 429s). The onError handler
   * applies these when serializing the response, with FORBIDDEN_ERROR_HEADERS
   * stripped. Keys are case-insensitive — they are lowercased before set. */
  readonly headers?: Readonly<Record<string, string>>;

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'DomainError';
    if (headers) this.headers = headers;
  }
}

export const Unauthorized = (msg = 'invalid_api_key'): DomainError =>
  new DomainError(msg, 401, 'unauthorized');

export const Forbidden = (msg = 'forbidden', code = 'forbidden'): DomainError =>
  new DomainError(msg, 403, code);

export const QuotaExceeded = (msg = 'quota_exceeded'): DomainError =>
  new DomainError(msg, 429, 'quota_exceeded');

export const UpstreamFailed = (
  msg: string,
  status = 502,
  code = 'upstream_failed',
): DomainError => new DomainError(msg, status, code);

export const ConfigError = (msg: string): DomainError =>
  new DomainError(msg, 500, 'config_error');

export const InvalidRequest = (msg: string, code = 'invalid_request'): DomainError =>
  new DomainError(msg, 400, code);

export const NotFound = (msg: string, code = 'not_found'): DomainError =>
  new DomainError(msg, 404, code);

export const Conflict = (msg: string, code = 'conflict'): DomainError =>
  new DomainError(msg, 409, code);

export const TooManyRequests = (
  msg: string,
  headers?: Readonly<Record<string, string>>,
): DomainError => new DomainError(msg, 429, 'too_many_requests', headers);

export const PayloadTooLarge = (msg: string, code = 'payload_too_large'): DomainError =>
  new DomainError(msg, 413, code);

export const CsrfFailed = (msg: string): DomainError =>
  new DomainError(msg, 403, 'csrf_failed');
