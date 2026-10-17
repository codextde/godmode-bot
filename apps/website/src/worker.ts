import { handle } from '@astrojs/cloudflare/handler';
import { runLifecycle } from '@/lib/mail';

export default {
  fetch: handle,
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runLifecycle().catch((e) => console.error('lifecycle run failed', e)));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
