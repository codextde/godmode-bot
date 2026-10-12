import { env } from 'cloudflare:workers';

// Downloads and app updates are served from the GitHub releases through this site:
// the Worker reads them with a read-only token and hands the browser a short-lived signed asset URL.
const REPO = 'codextde/godmode-bot';

type Asset = { id: number; name: string; url: string; browser_download_url: string };
type Release = { tag_name: string; name: string | null; body: string | null; published_at: string; draft: boolean; prerelease: boolean; assets: Asset[] };

const headers = (accept = 'application/vnd.github+json') => ({
  accept,
  'user-agent': 'godmode-website',
  'x-github-api-version': '2022-11-28',
  ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
});

const cached = (body: string, seconds: number) => new Response(body, { headers: { 'cache-control': `max-age=${seconds}` } });

/**
 * Latest published release, cached at the edge for five minutes. Without a token the API allows 60 calls an hour
 * per Cloudflare IP, so when it refuses, the last known release (kept a week) or the public release pages answer.
 */
export async function latestRelease(): Promise<Release> {
  const cache = await caches.open('godmode-releases');
  const fresh = new Request(`https://cache.internal/releases/latest`);
  const known = new Request(`https://cache.internal/releases/latest-known`);
  const hit = await cache.match(fresh);
  if (hit) return hit.json();
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: headers() }).catch(() => null);
  if (res?.ok) {
    const body = await res.text();
    await Promise.all([cache.put(fresh, cached(body, 300)), cache.put(known, cached(body, 604800))]);
    return JSON.parse(body);
  }
  const old = await cache.match(known);
  if (old) return old.json();
  const release = await releaseFromPages(await latestTag());
  await cache.put(fresh, cached(JSON.stringify(release), 300));
  return release;
}

async function latestTag(): Promise<string> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual' });
  const tag = res.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1];
  if (!tag) throw new Error(`GitHub latest release: ${res.status}`);
  return decodeURIComponent(tag);
}

/** A release read from github.com instead of the API: tag and asset names only. */
async function releaseFromPages(tag: string): Promise<Release> {
  const res = await fetch(`https://github.com/${REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`);
  if (!res.ok) throw new Error(`GitHub release page ${tag}: ${res.status}`);
  const prefix = `/${REPO}/releases/download/${tag}/`;
  const names = new Set([...(await res.text()).matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h.startsWith(prefix)).map((h) => decodeURIComponent(h.slice(prefix.length))));
  const assets = [...names].map((name, i) => {
    const url = `https://github.com${prefix}${encodeURIComponent(name)}`;
    return { id: -1 - i, name, url, browser_download_url: url };
  });
  return { tag_name: tag, name: `Godmode Bot ${tag}`, body: null, published_at: '', draft: false, prerelease: tag.includes('-'), assets };
}

/** Recent published releases for the changelog, cached at the edge for five minutes. */
export async function recentReleases(): Promise<Release[]> {
  const cache = await caches.open('godmode-releases');
  const cacheKey = new Request(`https://cache.internal/releases/recent`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub releases: ${res.status}`);
  const releases = ((await res.json()) as Release[]).filter((r) => !r.draft);
  await cache.put(cacheKey, new Response(JSON.stringify(releases), { headers: { 'cache-control': 'max-age=300' } }));
  return releases;
}

/** A release by tag (`v0.2.0`) or the latest one. */
export async function releaseFor(version: string | null): Promise<Release> {
  if (!version || version === 'latest') return latestRelease();
  const tag = version.startsWith('v') ? version : `v${version}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers: headers() }).catch(() => null);
  return res?.ok ? res.json() : releaseFromPages(tag);
}

/** A redirect to a short-lived download URL for one release asset. */
export async function assetRedirect(asset: Asset): Promise<Response> {
  if (!env.GITHUB_TOKEN || asset.id < 0) return Response.redirect(asset.browser_download_url, 302);
  const res = await fetch(asset.url, { headers: headers('application/octet-stream'), redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`GitHub asset ${asset.name}: ${res.status}`);
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

export async function assetText(asset: Asset): Promise<string> {
  // The public download URL needs no API call; GitHub redirects it to a signed storage URL.
  const res = await fetch(asset.browser_download_url);
  if (!res.ok) throw new Error(`GitHub asset ${asset.name}: ${res.status}`);
  return res.text();
}

/** What each download button fetches from a release. */
export const PLATFORMS: Record<string, { label: string; match: RegExp }> = {
  mac: { label: 'macOS (Apple silicon)', match: /_aarch64\.dmg$/ },
  'mac-intel': { label: 'macOS (Intel)', match: /_x64\.dmg$/ },
  windows: { label: 'Windows installer', match: /_x64-setup\.exe$/ },
  'windows-msi': { label: 'Windows MSI', match: /_x64_en-US\.msi$/ },
  linux: { label: 'Linux AppImage', match: /_amd64\.AppImage$/ },
  'linux-deb': { label: 'Linux .deb', match: /_amd64\.deb$/ },
  'linux-rpm': { label: 'Linux .rpm', match: /\.x86_64\.rpm$/ },
  'server-macos-arm64': { label: 'Headless server · macOS arm64', match: /^godmode-darwin-arm64$/ },
  'server-macos-x64': { label: 'Headless server · macOS x64', match: /^godmode-darwin-x64$/ },
  'server-linux-x64': { label: 'Headless server · Linux x64', match: /^godmode-linux-x64$/ },
  'server-linux-arm64': { label: 'Headless server · Linux arm64', match: /^godmode-linux-arm64$/ },
  'server-windows-x64': { label: 'Headless server · Windows x64', match: /^godmode-windows-x64\.exe$/ },
};
