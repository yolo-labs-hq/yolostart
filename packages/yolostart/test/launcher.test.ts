import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveExecutable, launch } from '../src/launcher.js';
import { RELEASE_BASE, trustedReleaseRedirect } from '../src/release-url.mjs';
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const version = '42.1.2'; // Deliberately independent of either package or native version.
const raw = Buffer.from('#!/bin/sh\n[ "$1" = "--scan" ] && [ "$2" = "/a path" ] || exit 99\nexit 42\n');
async function fixture(t: TestContext, binary = raw) {
  const home = await mkdtemp(path.join(tmpdir(), 'yolostart-bootstrap-'));
  const compressed = gzipSync(binary);
  const files = Object.fromEntries(['linux-amd64','linux-arm64','darwin-amd64','darwin-arm64'].map(target => [target, {
    file: `yolostart-${target}.gz`, sha256: digest(compressed), executableSha256: digest(binary)
  }]));
  const manifest = { version, files };
  const requests: string[] = [];
  const responses = new Map<string, { status?: number; body: Buffer | string; location?: string }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const override = responses.get(url.pathname);
    if (override) { res.writeHead(override.status ?? 200, override.location ? {location: override.location} : {}); res.end(override.body); }
    else if (url.pathname.endsWith('/latest.txt')) res.end(version + '\n');
    else if (url.pathname.endsWith('/manifest.json')) res.end(JSON.stringify(manifest));
    else if (url.pathname.endsWith('.gz')) res.end(compressed);
    else { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as {port: number};
  const base = `http://127.0.0.1:${address.port}`;
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push(String(input));
    assert.equal(init?.redirect, 'manual');
    return fetch(base + new URL(String(input)).pathname, init);
  };
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, {recursive:true,force:true}); });
  return {home, compressed, manifest, responses, requests, base, options: {platform:'linux', arch:'x64', env:{XDG_CACHE_HOME:home}, fetchImpl}};
}
test('latest resolves independently, fetches one platform and forwards arguments/exit status', async t => {
  const f = await fixture(t);
  assert.equal(await launch(['--scan','/a path'], f.options), 42);
  assert.deepEqual(f.requests, [RELEASE_BASE+'latest.txt',RELEASE_BASE+version+'/manifest.json',RELEASE_BASE+version+'/yolostart-linux-amd64.gz']);
});
test('pins skip latest; platform mapping and HOME cache fallback work', async t => {
  const f = await fixture(t);
  const executable = await resolveExecutable({...f.options, platform:'darwin',arch:'arm64',env:{HOME:f.home,YOLOSTART_VERSION:version}});
  assert.equal(executable,path.join(f.home,'.cache','yolostart',version,'yolostart-darwin-arm64'));
  assert.equal(f.requests.length,2); assert.match(f.requests[1], /darwin-arm64\.gz$/);
});
test('rejects tampered compressed and executable bytes before publishing cache files', async t => {
  for (const layer of ['compressed','executable']) await t.test(layer, async t => {
    const f = await fixture(t);
    if (layer === 'compressed') f.responses.set(`/releases/${version}/yolostart-linux-amd64.gz`,{body:gzipSync(Buffer.from('tampered'))});
    else f.manifest.files['linux-amd64'].executableSha256 = '0'.repeat(64);
    await assert.rejects(resolveExecutable(f.options), /checksum mismatch.*curl -fsSL https:\/\/yolostart.sh \| sh/);
    assert.deepEqual(await readdir(path.join(f.home,'yolostart',version)),[]);
  });
});
test('valid cache avoids binary download; truncated executable and gzip are repaired safely', async t => {
  const f = await fixture(t), executable = await resolveExecutable(f.options);
  await resolveExecutable(f.options);
  assert.equal(f.requests.filter(x=>x.endsWith('.gz')).length,1);
  await writeFile(executable,'truncated');
  await resolveExecutable(f.options);
  assert.deepEqual(await readFile(executable),raw);
  assert.equal(f.requests.filter(x=>x.endsWith('.gz')).length,1);
  await writeFile(executable+'.gz','truncated');
  await resolveExecutable(f.options);
  assert.equal(f.requests.filter(x=>x.endsWith('.gz')).length,2);
  assert.equal((await stat(executable)).mode & 0o777,0o700);
  f.manifest.files['linux-amd64'].executableSha256 = '0'.repeat(64);
  await assert.rejects(resolveExecutable(f.options), /checksum mismatch/); // Fresh manifest also governs hits.
});
test('concurrent runs and an interrupted temporary write cannot expose truncated executable bytes', async t => {
  const f = await fixture(t), dir = path.join(f.home,'yolostart',version);
  await mkdir(path.join(dir,'.download-interrupted'),{recursive:true});
  await writeFile(path.join(dir,'.download-interrupted','verified'),'partial');
  const paths = await Promise.all(Array.from({length:8},()=>resolveExecutable(f.options)));
  assert.equal(new Set(paths).size,1);
  assert.deepEqual(await readFile(paths[0]),raw);
  assert.deepEqual((await readdir(dir)).sort(),['.download-interrupted','yolostart-linux-amd64','yolostart-linux-amd64.gz']);
});
test('rejects unsupported platform, invalid versions, manifests and oversized decompression', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveExecutable({...f.options,platform:'win32'}),/supports macOS\/Linux/);
  await assert.rejects(resolveExecutable({...f.options,env:{YOLOSTART_VERSION:'../escape'}}),/Invalid YOLOSTART_VERSION/);
  assert.equal(f.requests.length,0);
  f.manifest.files['linux-amd64'].file = '../escape.gz';
  await assert.rejects(resolveExecutable(f.options),/Invalid native release manifest/);
  const bomb = await fixture(t,Buffer.alloc(64*1024*1024+1));
  await assert.rejects(resolveExecutable(bomb.options),/curl -fsSL/);
});
test('redirects admit only the same artifact on the official downloads host', async t => {
  const f = await fixture(t), source = `${RELEASE_BASE}${version}/yolostart-linux-amd64.gz`;
  const target = `https://dl.yolo.studio/yolostart/${version}/yolostart-linux-amd64.gz`;
  for (const bad of ['https://evil.example/file',target+'?token=x',target.replace(version,'1.2.3'),target.replace('https://','https://user@')]) {
    assert.equal(trustedReleaseRedirect(source,bad),false);
    f.responses.set(new URL(source).pathname,{status:302,location:bad,body:''});
    await assert.rejects(resolveExecutable(f.options),/Untrusted release redirect/);
  }
  f.responses.set(new URL(source).pathname,{status:302,location:target,body:''});
  await resolveExecutable(f.options);
  assert.equal(f.requests.at(-1),target);
  assert.equal(trustedReleaseRedirect(target,target),false);
});
test('SIGINT/SIGTERM reach the child and propagate terminal exit status', async t => {
  for (const [signal,code] of [['SIGINT',130],['SIGTERM',143]] as const) await t.test(signal,async t => {
    const f = await fixture(t,Buffer.from('#!/bin/sh\ntrap "exit 130" INT\ntrap "exit 143" TERM\necho READY\nwhile :; do sleep 0.1; done\n'));
    const script = `import {launch} from ${JSON.stringify(new URL('../dist/launcher.js',import.meta.url).href)};
      process.exitCode=await launch([], {env:{XDG_CACHE_HOME:${JSON.stringify(f.home)}},fetchImpl:(url,init)=>fetch(${JSON.stringify(f.base)}+new URL(url).pathname,init)});`;
    const child = spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    t.after(()=>{child.kill('SIGKILL');});
    const completion = once(child,'close');
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Child did not become ready')),10000);
      child.stdout.on('data',chunk=>{if(String(chunk).includes('READY')){clearTimeout(timer);resolve();}});
    });
    child.kill(signal);
    assert.equal((await completion)[0],code);
  });
});
test('built bootstrap has no interactive APIs or retired scanner', async () => {
  const dist = new URL('../dist/',import.meta.url);
  const files = (await readdir(dist)).filter(x=>/\.(?:m?js)$/.test(x)).sort();
  assert.deepEqual(files,['cli.js','launcher.js','release-url.mjs']);
  for (const file of files) assert.doesNotMatch(await readFile(new URL(file,dist),'utf8'),/readline|createInterface|\/dev\/tty|\b(?:inquirer|enquirer|prompts)\b|\bprompt\s*\(|process\.stdin|setRawMode|isTTY/);
});
