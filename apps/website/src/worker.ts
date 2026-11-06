import { handle } from '@astrojs/cloudflare/handler';
import { runLifecycle, runRecovery } from '@/lib/mail';
import { runPartners } from '@/lib/partners';

export default {
  fetch: handle,
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runLifecycle().catch((e) => console.error('lifecycle run failed', e)));
    ctx.waitUntil(runRecovery().catch((e) => console.error('recovery run failed', e)));
    ctx.waitUntil(runPartners().catch((e) => console.error('partners run failed', e)));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
