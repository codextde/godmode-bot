import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(import.meta.dirname, 'src'),
      'cloudflare:workers': path.join(import.meta.dirname, 'test/cloudflare-workers.ts'),
    },
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
