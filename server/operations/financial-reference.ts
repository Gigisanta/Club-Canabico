import { containsRecognizableCredential } from "./legacy-reader.js";

const sensitiveQueryKey = /^(?:sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|x-goog-security-token|access_token|token|api[_-]?key|key|password|secret|authorization|auth|code)$/i;

export function hasSensitiveFinancialReference(value: string): boolean {
  if (containsRecognizableCredential(value)) return true;
  for (const candidate of value.match(/https?:\/\/[^\s]+/gi) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password || [...url.searchParams.keys()].some(key => sensitiveQueryKey.test(key))) return true;
    } catch { /* A malformed URL remains a plain reference, never a request. */ }
  }
  return false;
}

export function safeFinancialReference(value: string): string {
  return hasSensitiveFinancialReference(value) ? "[excluded authentication material]" : value;
}
