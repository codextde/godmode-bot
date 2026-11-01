import { beforeEach, describe, expect, it } from 'vitest';
import { recordExpiredCheckout, recordSiteOptIn } from '@/lib/db';
import { runRecovery } from '@/lib/mail';
import { composeRecovery, recoveryDue, type RecoveryRow } from '@/lib/recovery';
import { emailFromUnsubscribeToken } from '@/lib/signed';
import { env } from 'cloudflare:workers';
import { DAY, expiredSession, HOUR, setupEnv, type Sent } from './fixtures';

const T0 = Date.UTC(2026, 10, 2, 12);

describe('recoveryDue', () => {
  const row: RecoveryRow = {
    session_id: 'cs_1',
    expired_at: T0,
    plan: 'monthly',
    email: 'ann@example.com',
    consent: 'opt_in',
    recovery_url: 'https://buy.stripe.com/r/x',
    recovery_expires_at: T0 + 30 * DAY,
  };
  const clean = { mailed: false, bought: false, unsubscribed: false };

  it('is due a day after expiry, with consent', () => {
    expect(recoveryDue(row, clean, T0 + DAY)).toBe(true);
    expect(recoveryDue(row, clean, T0 + DAY - 1)).toBe(false);
  });
  it('is never due without an explicit opt-in', () => {
    expect(recoveryDue({ ...row, consent: null }, clean, T0 + DAY)).toBe(false);
    expect(recoveryDue({ ...row, consent: 'opt_out' }, clean, T0 + DAY)).toBe(false);
  });
  it('needs an email and a recovery link', () => {
    expect(recoveryDue({ ...row, email: null }, clean, T0 + DAY)).toBe(false);
    expect(recoveryDue({ ...row, recovery_url: null }, clean, T0 + DAY)).toBe(false);
  });
  it('lets stale checkouts go', () => {
    expect(recoveryDue(row, clean, T0 + 3 * DAY)).toBe(false);
    expect(recoveryDue({ ...row, recovery_expires_at: T0 + DAY }, clean, T0 + DAY)).toBe(false);
  });
  it('skips people already mailed, buyers and unsubscribers', () => {
    expect(recoveryDue(row, { ...clean, mailed: true }, T0 + DAY)).toBe(false);
    expect(recoveryDue(row, { ...clean, bought: true }, T0 + DAY)).toBe(false);
    expect(recoveryDue(row, { ...clean, unsubscribed: true }, T0 + DAY)).toBe(false);
  });
});

describe('runRecovery', () => {
  let db: ReturnType<typeof setupEnv>['db'];
  let sent: Sent[];
  beforeEach(() => ({ db, sent } = setupEnv()));

  const expire = (over: Parameters<typeof expiredSession>[0] = {}) =>
    recordExpiredCheckout(expiredSession(over, T0), T0);
  const kinds = () => db.sql.prepare('SELECT session_id, kind, message_id FROM emails').all().map((r) => ({ ...r }));

  it('sends one recovery email a day after expiry and records it', async () => {
    await expire();
    await runRecovery(T0 + 23 * HOUR);
    expect(sent).toHaveLength(0);

    await runRecovery(T0 + DAY + HOUR);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ann@example.com');
    expect(sent[0].subject).toBe('Your Godmode checkout');
    expect(sent[0].text).toContain('https://buy.stripe.com/r/test_recover1');
    expect(sent[0].text).toContain('https://usegodmode.com/download');
    expect(sent[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(kinds()).toEqual([{ session_id: 'cs_test_abandoned1', kind: 'recovery', message_id: '<m1@usegodmode.com>' }]);

    await runRecovery(T0 + DAY + 2 * HOUR);
    expect(sent).toHaveLength(1);
  });

  it('never sends a second reminder to the same person', async () => {
    await expire();
    await runRecovery(T0 + DAY + HOUR);
    await recordExpiredCheckout(expiredSession({ id: 'cs_test_abandoned2' }, T0 + DAY), T0 + DAY);
    await runRecovery(T0 + 2 * DAY + HOUR);
    expect(sent).toHaveLength(1);
  });

  it('sends one email when two abandoned checkouts are due in the same run', async () => {
    await expire();
    await recordExpiredCheckout(expiredSession({ id: 'cs_test_abandoned2' }, T0 + HOUR), T0 + HOUR);
    await runRecovery(T0 + DAY + 2 * HOUR);
    expect(sent).toHaveLength(1);
  });

  it('does not mail without consent', async () => {
    await expire({ consent: null });
    await expire({ id: 'cs_test_optout', consent: { promotions: 'opt_out', terms_of_service: null } });
    await runRecovery(T0 + DAY + HOUR);
    expect(sent).toHaveLength(0);
  });

  it('does not mail someone who bought in the meantime', async () => {
    await expire();
    db.sql.exec(`INSERT INTO orders (session_id, created_at, plan, mode, status, email, livemode)
      VALUES ('cs_test_paid', ${T0}, 'monthly', 'subscription', 'paid', 'ANN@example.com', 0)`);
    await runRecovery(T0 + DAY + HOUR);
    expect(sent).toHaveLength(0);
  });

  it('does not mail unsubscribed addresses', async () => {
    await expire();
    db.sql.exec(`INSERT INTO unsubscribes (email, ts) VALUES ('ann@example.com', ${T0})`);
    await runRecovery(T0 + DAY + HOUR);
    expect(sent).toHaveLength(0);
  });

  it('does not touch checkouts that expired before recovery existed', async () => {
    await expire({ after_expiration: null });
    await runRecovery(T0 + DAY + HOUR);
    expect(sent).toHaveLength(0);
  });

  it('only logs while lifecycle emails are off', async () => {
    env.LIFECYCLE_EMAILS = 'off';
    await expire();
    await runRecovery(T0 + DAY + HOUR);
    expect(sent).toHaveLength(0);
    expect(kinds()).toHaveLength(0);
  });

  it('frees the slot when sending fails, so the next run retries', async () => {
    await expire();
    (env.EMAIL as { send: (m: unknown) => Promise<unknown> }).send = async () => {
      throw new Error('mail down');
    };
    await runRecovery(T0 + DAY + HOUR);
    expect(kinds()).toHaveLength(0);
  });

  it('mails an opt-in from /checkout/canceled once the checkout expired', async () => {
    db.sql.exec(`INSERT INTO orders (session_id, created_at, plan, mode, status, livemode, utm_source)
      VALUES ('cs_test_abandoned1', ${T0 - DAY}, 'monthly', 'subscription', 'open', 0, 'google')`);
    expect(await recordSiteOptIn('cs_test_abandoned1', 'bob@example.com')).toBe(true);
    expect(await recordSiteOptIn('cs_test_unknown', 'bob@example.com')).toBe(false);
    await expire({ customer_details: null, consent: null });
    await runRecovery(T0 + DAY + HOUR);
    expect(sent.map((m) => m.to)).toEqual(['bob@example.com']);
  });

  it('links an unsubscribe token that resolves back to the address', async () => {
    await expire();
    await runRecovery(T0 + DAY + HOUR);
    const url = new URL(sent[0].text.match(/https:\/\/usegodmode\.com\/unsubscribe\?t=\S+/)![0]);
    expect(await emailFromUnsubscribeToken(url.searchParams.get('t'))).toBe('ann@example.com');
    expect(sent[0].headers?.['List-Unsubscribe']).toBe(`<${url.href}>`);
  });
});

describe('composeRecovery', () => {
  it('reads like a short personal note', () => {
    const mail = composeRecovery(
      { session_id: 'cs_1', expired_at: T0, plan: 'monthly', email: 'a@b.co', consent: 'opt_in', recovery_url: 'https://buy.stripe.com/r/x', recovery_expires_at: null },
      'https://usegodmode.com',
      'https://usegodmode.com/unsubscribe?t=abc',
    );
    expect(mail.text).toMatch(/^Hi,\n\nsaw you started the Godmode checkout/);
    expect(mail.text).toContain('Pro Monthly, $39/month');
    expect(mail.text).toContain('Unsubscribe: https://usegodmode.com/unsubscribe?t=abc');
    expect(mail.html).toContain('<a href="https://buy.stripe.com/r/x"');
    expect(mail.text).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
