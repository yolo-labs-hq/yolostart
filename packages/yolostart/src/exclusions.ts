export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "target",
  "vendor",
  "__pycache__",
]);
export function sensitivePath(path: string): boolean {
  return path
    .split("/")
    .some((part) =>
      /^(?:\.env.*|.*\.pem|id_rsa.*|.*\.key|credentials\.json|\.aws|\.ssh|\.npmrc|\.netrc|\.npmtoken|.*service[-_]?account.*\.json)$/i.test(
        part,
      ),
    );
}
// Google service-account keys can have arbitrary download names. Inspect JSON
// locally; never retain contents in metadata. Malformed secret-shaped JSON is
// also excluded, so truncation cannot turn a private_key into an include.
export function sensitiveJson(contents: string): boolean {
  if (
    /"(?:private_key|private_key_id|client_secret)"\s*:/.test(contents) ||
    /"type"\s*:\s*"service_account"/.test(contents)
  )
    return true;
  try {
    const pending: unknown[] = [JSON.parse(contents)];
    while (pending.length) {
      const value = pending.pop();
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (
            ["private_key", "private_key_id", "client_secret"].includes(key) ||
            (key === "type" && child === "service_account")
          )
            return true;
          if (child && typeof child === "object") pending.push(child);
        }
      }
    }
  } catch {
    /* Malformed JSON still receives the conservative lexical check above. */
  }
  return false;
}
