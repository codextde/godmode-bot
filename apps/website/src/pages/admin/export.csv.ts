import type { APIRoute } from 'astro';
import { checkAdmin } from '@/lib/auth';
import { db } from '@/lib/db';

export const prerender = false;

const csv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    let s = v == null ? '' : String(v);
    // Spreadsheet apps execute cells starting with these as formulas; values come from visitors.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
};

/** /admin/export.csv?what=orders|leads */
export const GET: APIRoute = async ({ request, url }) => {
  const denied = checkAdmin(request);
  if (denied) return denied;
  const what = url.searchParams.get('what') === 'leads' ? 'leads' : 'orders';
  const sql =
    what === 'leads'
      ? `SELECT datetime(ts/1000, 'unixepoch') AS date, email, source, utm_source, utm_campaign FROM leads ORDER BY ts DESC`
      : `SELECT datetime(created_at/1000, 'unixepoch') AS created, datetime(paid_at/1000, 'unixepoch') AS paid, plan, mode,
           status, sub_status, datetime(trial_end/1000, 'unixepoch') AS trial_end, datetime(period_end/1000, 'unixepoch') AS period_end,
           cancel_at_period_end, comp, amount_total/100.0 AS amount, currency, email, name, country, license_key, utm_source,
           utm_medium, utm_campaign, utm_content, twclid, referrer, livemode, session_id FROM orders ORDER BY created_at DESC`;
  const { results } = await db().prepare(sql).all();
  return new Response(csv(results as Record<string, unknown>[]), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="godmode-${what}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
