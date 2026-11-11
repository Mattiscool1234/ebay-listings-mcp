import { createHash, timingSafeEqual } from 'node:crypto';

const TOKEN_PATTERN = /v\^1\.1#[^\s"'\\]+/g;
const BASIC_PATTERN = /Basic\s+[A-Za-z0-9+/=]+/gi;
const BEARER_PATTERN = /Bearer\s+\S+/gi;

export function secureEquals(provided: string, expected: string): boolean {
  const left = createHash('sha256').update(provided).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    output = output.split(secret).join('[redacted]');
  }
  return output
    .replace(TOKEN_PATTERN, '[redacted-token]')
    .replace(BASIC_PATTERN, 'Basic [redacted]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]');
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
