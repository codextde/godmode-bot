// English lives at the root, German under /de. Components read the language from the page URL, so a page only has to
// exist under both paths (see TRANSLATED) to render in either language.

export type Lang = 'en' | 'de';
export const LANGS: readonly Lang[] = ['en', 'de'];
export const LOCALES: Record<Lang, string> = { en: 'en_US', de: 'de_DE' };

/** Paths (without the /de prefix) that exist in both languages. Everything else is English only. */
export const TRANSLATED = ['/', '/download', '/setup', '/use-cases', '/support'] as const;

/** The public path of a page: prerendered pages see "/de/setup.html" or "/index.html" at build time. */
export const cleanPath = (pathname: string) => pathname.replace(/\.html$/, '').replace(/\/index$/, '').replace(/\/$/, '') || '/';

export const langOf = (url: URL): Lang => {
  const p = cleanPath(url.pathname);
  return p === '/de' || p.startsWith('/de/') ? 'de' : 'en';
};

/** "/de/setup" -> "/setup", "/de" -> "/". */
export function basePath(pathname: string): string {
  const p = cleanPath(pathname);
  return (p === '/de' ? '/' : p.startsWith('/de/') ? p.slice(3) : p) || '/';
}

export const isTranslated = (pathname: string) => (TRANSLATED as readonly string[]).includes(basePath(pathname));

/**
 * A site link in the given language: "/download" -> "/de/download", "/#pricing" -> "/de#pricing". Links to English-only
 * pages (legal, playbook…) and anchors on the same page stay as they are.
 */
export function href(lang: Lang, path: string): string {
  if (lang === 'en' || !path.startsWith('/') || path.startsWith('/de')) return path;
  const m = /^([^?#]*)(.*)$/.exec(path)!;
  const p = m[1] || '/';
  if (!(TRANSLATED as readonly string[]).includes(p)) return path;
  return (p === '/' ? '/de' : `/de${p}`) + m[2];
}

/** The same page in the other language, or that language's home when the page has no translation. */
export function counterpart(pathname: string, to: Lang): string {
  const p = basePath(pathname);
  if (!isTranslated(p)) return to === 'de' ? '/de' : '/';
  return to === 'de' ? href('de', p) : p;
}

/** Pick the text for the page's language from an { en, de } pair. */
export const pick = <T>(lang: Lang, both: { en: T; de: T }): T => both[lang];
