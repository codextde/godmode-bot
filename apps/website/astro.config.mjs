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
  // Off: in-app webviews and privacy browsers send `Origin: null` or none, which blocked checkout. /admin checks the origin itself.
  security: { checkOrigin: false },
  vite: {
    plugins: [tailwindcss()],
  },
});
