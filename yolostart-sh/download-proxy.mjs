// Keep historical Host URLs byte-identical when their immutable payload is
// already on dl.yolo.studio. Never return an unverified upstream response.
export async function serveDownload(record, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(record.url, {
      redirect: 'error', headers: {'User-Agent': 'yolostart-release/1 (+https://yolo.studio)'},
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok || !response.body) throw Error('download unavailable');
    const data = new Uint8Array(record.bytes);
    let offset = 0;
    for await (const chunk of response.body) {
      if (offset + chunk.length > data.length) throw Error('download too large');
      data.set(chunk, offset); offset += chunk.length;
    }
    if (offset !== data.length) throw Error('download truncated');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== record.sha256) throw Error('download changed');
    return new Response(data, {headers:{'Content-Type':'application/gzip', 'Cache-Control':'public, max-age=31536000, immutable'}});
  } catch {
    return new Response('Release download unavailable', {status:502, headers:{'Cache-Control':'no-store'}});
  }
}
