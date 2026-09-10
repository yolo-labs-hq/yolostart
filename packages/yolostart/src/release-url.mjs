// Shared by the npm bootstrap and Host archive restoration. No arbitrary
// redirect hosts, alternate ports, credentials, query strings or chains.
export const RELEASE_BASE = 'https://yolostart-sh.yolo.host/releases/';
export function trustedReleaseRedirect(source, target) {
  try {
    const from = new URL(source), to = new URL(target, from);
    const match = from.pathname.match(/^\/releases\/([0-9A-Za-z.-]+)\/(manifest\.json|yolostart-[0-9A-Za-z.-]+\.(?:tgz|gz))$/);
    return from.origin === new URL(RELEASE_BASE).origin && !from.search && !from.hash && !from.username && !from.password
      && !!match && to.href === `https://dl.yolo.studio/yolostart/${match[1]}/${match[2]}`;
  } catch { return false; }
}
