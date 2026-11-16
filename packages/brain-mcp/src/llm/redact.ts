/**
 * Removes things that look like credentials from text before it is sent to an LLM. Files that are secrets
 * by name (.env, keys) are never read at all; this catches the ones that slip into ordinary source.
 * It is a safety net with known gaps, not a guarantee: it lowers the odds, it does not remove the need
 * to choose a model and provider you trust with your code.
 */
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED API KEY]"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "[REDACTED API KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, "[REDACTED GITHUB TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "[REDACTED GITHUB TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY ID]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED GOOGLE KEY]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED SLACK TOKEN]"],
  [/\b(?:eyJ[A-Za-z0-9_-]{10,})\.(?:eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g, "[REDACTED JWT]"],
  // user:password@ in a URL
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, "$1:[REDACTED]@"],
  // password = "..." / secret: '...' / api_key = "..." with a literal value of 8+ characters
  [/\b((?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*)(["'])[^"'\s]{8,}\2/gi, "$1$2[REDACTED]$2"],
];

export function redactSecrets(text: string): { text: string; redactions: number } {
  let count = 0;
  let out = text;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, (...args) => {
      count++;
      return replacement.replace(/\$(\d)/g, (_, i) => String(args[Number(i)] ?? ""));
    });
  }
  return { text: out, redactions: count };
}
