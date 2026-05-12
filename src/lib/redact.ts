const TOKEN_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{20,}/g, // OpenAI / Anthropic-style API keys
  /Bearer\s+[a-zA-Z0-9._-]+/gi, // Bearer tokens in log lines
  /sk-ant-[a-zA-Z0-9_-]{20,}/g, // Anthropic console keys
];

export const redact = (input: string): string =>
  TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), input);

export const redactObject = <T>(obj: T): T => {
  const json = JSON.stringify(obj);
  return JSON.parse(redact(json)) as T;
};
