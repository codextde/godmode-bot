import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

const site = process.env.SITE_URL ?? 'https://usegodmode.com';

export default defineConfig({
  site,
  trailingSlash: 'never',
  output: 'static',
  adapter: cloudflare({ imageService: 'compile' }),
  integrations: [
    sitemap({
      filter: (page) => !/\/(admin|checkout)(\/|$)/.test(page),
    }),
  ],
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
  build: { inlineStylesheets: 'always', format: 'file' },
  compressHTML: true,
  // In-app browsers (X, Instagram) send `Origin: null` on form posts; routes that need CSRF protection check the origin themselves.
  security: { checkOrigin: false },
  vite: {
    plugins: [tailwindcss()],
  },
});
