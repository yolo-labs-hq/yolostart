import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceAuth, AUTH_URL } from "../src/auth.js";
function harness(polls: { status: number; body: object }[], expires = 600) {
  let time = 0;
  const calls: { url: string; body: unknown }[] = [];
  const messages: string[] = [];
  const sleeps: number[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/code"))
      return Response.json({
        device_code: "private-device-code",
        user_code: "ABCD-2345",
        verification_uri: "https://yolo.studio/device",
        expires_in: expires,
        interval: 5,
      });
    const poll = polls.shift();
    assert.ok(poll, "unexpected poll");
    return Response.json(poll.body, { status: poll.status });
  };
  return {
    calls,
    messages,
    sleeps,
    options: {
      fetch: fetcher,
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
        sleeps.push(ms);
      },
      report: (message: string) => {
        messages.push(message);
      },
    },
  };
}
test("existing nested error envelope, poll interval, and token success without disclosure", async () => {
  const h = harness([
    { status: 400, body: { error: { message: "authorization_pending" } } },
    { status: 200, body: { access_token: "PRIVATE-TOKEN" } },
  ]);
  assert.equal(await deviceAuth(h.options), "PRIVATE-TOKEN");
  assert.deepEqual(
    h.calls.map((c) => c.url),
    [
      `${AUTH_URL}/device/code`,
      `${AUTH_URL}/device/token`,
      `${AUTH_URL}/device/token`,
    ],
  );
  assert.deepEqual(h.calls[1].body, { device_code: "private-device-code" });
  assert.deepEqual(h.sleeps, [5000, 5000]);
  assert.match(h.messages[0], /https:\/\/yolo.studio\/device\?code=ABCD-2345/);
  assert.doesNotMatch(
    h.messages.join("\n"),
    /PRIVATE-TOKEN|private-device-code/,
  );
});
test("denial and expiry terminate; slow_down increases the interval", async () => {
  const denied = harness([
    { status: 403, body: { error: { message: "access_denied" } } },
  ]);
  await assert.rejects(deviceAuth(denied.options), /denied/);
  const expired = harness([], 5);
  await assert.rejects(deviceAuth(expired.options), /expired/);
  assert.equal(expired.calls.length, 1);
  const slow = harness([
    { status: 400, body: { error: "slow_down" } },
    { status: 200, body: { access_token: "token" } },
  ]);
  await deviceAuth(slow.options);
  assert.deepEqual(slow.sleeps, [5000, 10000]);
});
test("HTTP errors terminate instead of polling forever or printing untrusted response text", async () => {
  const h = harness([
    { status: 500, body: { error: { message: "PRIVATE-DATA" } } },
  ]);
  await assert.rejects(deviceAuth(h.options), /HTTP 500/);
  assert.doesNotMatch(h.messages.join(""), /PRIVATE-DATA/);
  await assert.rejects(
    deviceAuth({ fetch: async () => Response.json({}, { status: 404 }) }),
    /unavailable/,
  );
});
