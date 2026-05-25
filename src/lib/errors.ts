export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const Unauthorized = (msg = 'invalid_api_key'): DomainError =>
  new DomainError(msg, 401, 'unauthorized');

export const Forbidden = (msg = 'forbidden'): DomainError =>
  new DomainError(msg, 403, 'forbidden');

export const QuotaExceeded = (msg = 'quota_exceeded'): DomainError =>
  new DomainError(msg, 429, 'quota_exceeded');

export const UpstreamFailed = (msg: string, status = 502): DomainError =>
  new DomainError(msg, status, 'upstream_failed');

export const ConfigError = (msg: string): DomainError =>
  new DomainError(msg, 500, 'config_error');

export const InvalidRequest = (msg: string, code = 'invalid_request'): DomainError =>
  new DomainError(msg, 400, code);

export const NotFound = (msg: string, code = 'not_found'): DomainError =>
  new DomainError(msg, 404, code);

export const Conflict = (msg: string, code = 'conflict'): DomainError =>
  new DomainError(msg, 409, code);

export const TooManyRequests = (msg: string): DomainError =>
  new DomainError(msg, 429, 'too_many_requests');

export const CsrfFailed = (msg: string): DomainError =>
  new DomainError(msg, 403, 'csrf_failed');
