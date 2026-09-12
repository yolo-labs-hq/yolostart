import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWorker } from '../build-worker.mjs';

test('offline worker generation preserves verified download redirects and asset fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yolostart-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = pathToFileURL(dir + '/');
  const releasePath = '/releases/1.0.0/yolostart-linux-amd64.gz';
  const download = 'https://dl.yolo.studio/yolostart/1.0.0/yolostart-linux-amd64.gz';
  await buildWorker({ [releasePath]: { url: download } }, output);
  const { default: worker } = await import(new URL('worker.mjs', output));
  const redirect = await worker.fetch(new Request('https://example.test' + releasePath));
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), download);
  assert.equal(redirect.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const response = await worker.fetch(new Request('https://example.test/releases/latest.txt'), {
    ASSETS: { fetch: request => {
      assert.equal(new URL(request.url).pathname, '/releases/latest.txt');
      return new Response('1.0.0\n');
    } },
  });
  assert.equal(await response.text(), '1.0.0\n');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
