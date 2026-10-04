import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Shared by the release build and offline host tests. Release inventory remains
// the build's responsibility; rendering a worker never rebuilds a native release.
export async function buildWorker(downloads, outputDirectory) {
  const script = await readFile(new URL("./install.sh", import.meta.url), "utf8");
  const banner = script.match(/cat <<'BANNER'\n([\s\S]*?)\nBANNER\n/)?.[1];
  if (!banner) throw Error('Installer banner missing');
  const template = await readFile(new URL('./landing.html', import.meta.url), 'utf8');
  if (template.split('<!-- INSTALL_BANNER -->').length !== 2) throw Error('Landing banner slot missing or duplicated');
  const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const svg = await readFile(new URL('./icons/octopus.svg', import.meta.url), 'utf8');
  if (template.split('<!-- OCTOPUS_SVG -->').length !== 2) throw Error('Landing octopus slot missing or duplicated');
  // The same octopus, inline as the page's mark: drop the XML prolog and mark it
  // decorative (the wordmark beside it carries the name).
  const octopus = svg.replace(/^<\?xml[^>]*>\s*/, '').replace('<svg ', '<svg class="mark" aria-hidden="true" focusable="false" ');
  const landing = template.replace('<!-- INSTALL_BANNER -->', () => escapeHtml(banner))
    .replace('<!-- OCTOPUS_SVG -->', () => octopus)
    .replace('<!-- ICON_SVG -->', () => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
  const icons = {};
  for (const [path, type] of [['favicon.ico', 'image/x-icon'], ['apple-touch-icon.png', 'image/png'], ['og.png', 'image/png']]) {
    icons['/' + path] = {type, bytes: (await readFile(new URL('./icons/' + path, import.meta.url))).toString('base64')};
  }
  const {version: bootstrapVersion} = JSON.parse(await readFile(new URL('../packages/yolostart/package.json', import.meta.url), 'utf8'));
  await mkdir(outputDirectory, {recursive:true});
  await writeFile(
    new URL('worker.mjs', outputDirectory),
  `// Generated from install.sh and landing.html; do not edit.
const script = ${JSON.stringify(script)};
const landing = ${JSON.stringify(landing)};
const downloads = ${JSON.stringify(downloads)};
const icons = ${JSON.stringify(icons)};
export default { fetch(request, env) {
  const url = new URL(request.url);
  if (icons[url.pathname]) {
    const icon = icons[url.pathname];
    return new Response(Uint8Array.from(atob(icon.bytes), c => c.charCodeAt(0)), {headers:{'Content-Type':icon.type, 'Cache-Control':'public, max-age=86400', 'X-Content-Type-Options':'nosniff'}});
  }
  const noStore = url.pathname === '/yolostart.tgz' || url.pathname === '/releases/latest.txt' || url.pathname === '/releases/index.json';
  if (url.pathname === '/yolostart.tgz') url.pathname = '/bootstrap/yolostart-${bootstrapVersion}.tgz';
  if (url.pathname.startsWith('/releases/') || url.pathname.startsWith('/bootstrap/')) {
    const response = downloads[url.pathname] ? new Response(null, {status:307, headers:{Location:downloads[url.pathname].url, 'Cache-Control':'public, max-age=31536000, immutable'}}) : env.ASSETS.fetch(new Request(url, request));
    if (!noStore) return response;
    return Promise.resolve(response).then(result => {
      const headers = new Headers(result.headers); headers.set('Cache-Control', 'no-store');
      return new Response(result.body, {status:result.status, headers});
    });
  }
  if (url.pathname === '/api/waitlist') {
    const json = (body, status) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    if (request.method !== 'POST') return json({error:'Method not allowed'}, 405);
    return (async () => {
      let email = '';
      try {
        const body = await request.json();
        if (body && typeof body.email === 'string') email = body.email.trim();
      } catch { email = ''; }
      // Cheap shape guard only; the upstream validates properly. Deliberately
      // regex-free — this source is emitted through a template literal, where a
      // stray backslash escape silently changes the pattern.
      const at = email.indexOf('@'), dot = email.lastIndexOf('.');
      const shaped = at > 0 && dot > at + 1 && dot < email.length - 1
        && email.length <= 254 && !email.includes(' ');
      if (!shaped) return json({error:'Enter a valid email address.'}, 400);
      try {
        // product and source are fixed HERE, never read from the request: a
        // browser must not be able to write itself into another product's list.
        const upstream = await fetch('https://waitlist.yololabs.ai/api/waitlist', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({email, product:'yolo-studio', source:'yolostart'}),
        });
        if (upstream.status === 409) return json({ok:true, already:true}, 200);
        if (!upstream.ok) return json({error:'Could not reach the list just now. Try again shortly.'}, 502);
        return json({ok:true}, 200);
      } catch {
        // Never surface the upstream body or error: it is not ours to leak.
        return json({error:'Could not reach the list just now. Try again shortly.'}, 502);
      }
    })();
  }
  if (url.pathname !== '/' && url.pathname !== '/install.sh') return new Response('Not found', {status:404});
  const isBrowser = request.headers.get('sec-fetch-dest') === 'document'
    || (request.headers.get('accept') ?? '').includes('text/html');
  // Link-preview and search crawlers need the HTML (its og:/twitter: tags), but
  // most send Accept: */* like curl. A narrow allow-list of their user agents
  // gets the landing page; curl, wget and every other client still get the
  // exact installer. Backslash-free on purpose: this source is emitted through
  // a template literal.
  const isPreviewBot = /facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|linkedinbot|discordbot|telegrambot|whatsapp|skypeuripreview|iframely|embedly|pinterest|redditbot|applebot|googlebot|google-inspectiontool|bingbot|duckduckbot|yandexbot|mastodon|bluesky|cardyb|vkshare/i.test(request.headers.get('user-agent') ?? '');
  const html = url.pathname === '/' && !url.searchParams.has('raw') && (isBrowser || isPreviewBot);
  return new Response(html ? landing : script, {headers:{
    'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Vary': 'Accept, Sec-Fetch-Dest, User-Agent',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }});
} };
`,
  );
}
