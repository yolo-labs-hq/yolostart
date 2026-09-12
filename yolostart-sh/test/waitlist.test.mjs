import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load the EMITTED worker, so this exercises what actually ships.
const src = readFileSync(new URL('../.test-dist/worker.mjs', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const worker = mod.default;

const post = (body, method = 'POST') => new Request('https://yolostart.sh/api/waitlist', {
  method, headers: { 'Content-Type': 'application/json' },
  body: method === 'POST' ? JSON.stringify(body) : undefined,
});
const env = { ASSETS: { fetch: async () => new Response('asset') } };

test('rejects a malformed address without ever calling upstream', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  for (const bad of ['', 'nope', 'a@b', 'a b@c.d', '@x.com', 'x@.com', 'x@y.']) {
    const res = await worker.fetch(post({ email: bad }), env);
    assert.equal(res.status, 400, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(called, false, 'upstream must not see obviously invalid input');
});

test('fixes product and source server-side — a client cannot claim another list', async () => {
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response('{}', { status: 200 }); };
  const res = await worker.fetch(post({ email: 'a@b.com', product: 'something-else', source: 'spoofed' }), env);
  assert.equal(res.status, 200);
  assert.equal(sent.url, 'https://waitlist.yololabs.ai/api/waitlist');
  assert.equal(sent.body.product, 'yolo-studio');
  assert.equal(sent.body.source, 'yolostart');
  assert.equal(sent.body.email, 'a@b.com');
});

test('an already-registered address reads as success, not failure', async () => {
  globalThis.fetch = async () => new Response('{"success":false}', { status: 409 });
  const res = await worker.fetch(post({ email: 'a@b.com' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, already: true });
});

test('never leaks the upstream body on failure', async () => {
  globalThis.fetch = async () => new Response('{"error":"internal detail: db=prod-3"}', { status: 500 });
  const res = await worker.fetch(post({ email: 'a@b.com' }), env);
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.doesNotMatch(text, /internal detail|prod-3/);
});

test('survives an upstream that throws', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const res = await worker.fetch(post({ email: 'a@b.com' }), env);
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /network down/);
});

test('refuses non-POST', async () => {
  const res = await worker.fetch(post(null, 'GET'), env);
  assert.equal(res.status, 405);
});
