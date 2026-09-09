export const AUTH_URL = "https://auth.yololabs.ai/api/v1/auth";
interface AuthOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  report?: (message: string) => void;
}
export async function deviceAuth(options: AuthOptions = {}): Promise<string> {
  const request = options.fetch ?? fetch;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const report = options.report ?? ((message) => console.error(message));
  async function post(route: string, body: object) {
    const response = await request(`${AUTH_URL}/device/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json()) as Record<string, unknown>;
    return { response, data };
  }
  const { response, data } = await post("code", {});
  if (!response.ok)
    throw new Error(`Device sign-in unavailable (HTTP ${response.status}).`);
  if (
    typeof data.device_code !== "string" ||
    typeof data.user_code !== "string" ||
    typeof data.verification_uri !== "string" ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  )
    throw new Error("Invalid device sign-in response.");
  const verification = new URL(data.verification_uri);
  if (verification.protocol !== "https:")
    throw new Error("Device verification requires HTTPS.");
  verification.searchParams.set("code", data.user_code);
  report(`Sign in: ${verification.href}\nWaiting for browser approval...`);
  const deadline = now() + Math.min(data.expires_in, 600) * 1000;
  let interval =
    typeof data.interval === "number" && Number.isFinite(data.interval)
      ? Math.max(5, data.interval)
      : 5;
  while (now() < deadline) {
    await sleep(Math.min(interval * 1000, deadline - now()));
    if (now() >= deadline) break;
    const poll = await post("token", { device_code: data.device_code });
    if (
      poll.response.ok &&
      typeof poll.data.access_token === "string" &&
      poll.data.access_token
    ) {
      report("Signed in.");
      return poll.data.access_token; // Memory only; never print or persist tokens.
    }
    const error = poll.data.error;
    const message =
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? error.message
          : undefined;
    if (poll.response.status === 400 && message === "authorization_pending")
      continue;
    if (poll.response.status === 400 && message === "slow_down") {
      interval += 5;
      continue;
    }
    if (message === "access_denied") throw new Error("Device sign-in denied.");
    if (message === "expired_token" || message === "Device code expired") break;
    throw new Error(
      `Device sign-in failed (HTTP ${poll.response.status}). Re-run to sign in again.`,
    );
  }
  throw new Error("Device sign-in expired. Re-run to sign in again.");
}
