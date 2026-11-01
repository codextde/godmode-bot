import { describe, expect, test } from 'bun:test';
import { composeFree, dueFreeKinds, type FreeLead } from '../src/lib/free-emails';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const lead = (over: Partial<FreeLead> = {}): FreeLead => ({
  id: 7,
  email: 'sam@example.com',
  free_ends_at: NOW + 10 * DAY,
  locale: 'en',
  unsubscribed_at: null,
  ...over,
});

describe('dueFreeKinds', () => {
  test('the welcome while more than 3 days are left', () => {
    expect(dueFreeKinds(lead(), NOW)).toEqual(['free_welcome']);
    expect(dueFreeKinds(lead({ free_ends_at: NOW + 3 * DAY + 1 }), NOW)).toEqual(['free_welcome']);
  });

  test('the reminder in the last 3 days, instead of the welcome', () => {
    expect(dueFreeKinds(lead({ free_ends_at: NOW + 3 * DAY }), NOW)).toEqual(['free_ending']);
    expect(dueFreeKinds(lead({ free_ends_at: NOW + 1 }), NOW)).toEqual(['free_ending']);
  });

  test('nothing on the last day, then one note 1 to 3 days after the end', () => {
    expect(dueFreeKinds(lead({ free_ends_at: NOW }), NOW)).toEqual([]);
    expect(dueFreeKinds(lead({ free_ends_at: NOW - DAY + 1 }), NOW)).toEqual([]);
    expect(dueFreeKinds(lead({ free_ends_at: NOW - DAY }), NOW)).toEqual(['free_ended']);
    expect(dueFreeKinds(lead({ free_ends_at: NOW - 3 * DAY + 1 }), NOW)).toEqual(['free_ended']);
    expect(dueFreeKinds(lead({ free_ends_at: NOW - 3 * DAY }), NOW)).toEqual([]);
  });

  test('nothing without an end date or after an unsubscribe', () => {
    expect(dueFreeKinds(lead({ free_ends_at: null }), NOW)).toEqual([]);
    expect(dueFreeKinds(lead({ unsubscribed_at: NOW - DAY }), NOW)).toEqual([]);
  });
});

describe('composeFree', () => {
  const unsub = 'https://usegodmode.com/api/unsubscribe?e=u7.123.sig';

  test('every mail has the unsubscribe link and no raw address in it', () => {
    for (const kind of ['free_welcome', 'free_ending', 'free_ended'] as const) {
      for (const locale of ['en', 'de']) {
        const mail = composeFree(kind, lead({ locale, free_ends_at: NOW + 2 * DAY }), 'https://usegodmode.com', unsub, NOW);
        expect(mail.text).toContain(unsub);
        expect(mail.html).toContain(unsub);
        expect(mail.text).not.toContain('sam@example.com');
      }
    }
  });

  test('the reminder counts the days left and links a checkout without a card trial', () => {
    const mail = composeFree('free_ending', lead({ free_ends_at: NOW + 2 * DAY }), 'https://usegodmode.com', unsub, NOW);
    expect(mail.subject).toBe('Your free Godmode ends in 2 days');
    expect(mail.text).toContain('https://usegodmode.com/api/checkout?plan=monthly&trial=0&utm_source=email&utm_medium=free_ending');
    expect(mail.text).toContain('$39 a month, or $29 a month billed yearly');
    expect(composeFree('free_ending', lead({ free_ends_at: NOW + 3_600_000 }), 'https://usegodmode.com', unsub, NOW).subject).toBe('Your free Godmode ends tomorrow');
  });

  test('German for locale de, and the ended note offers yearly too', () => {
    const mail = composeFree('free_ended', lead({ locale: 'de', free_ends_at: NOW - DAY }), 'https://usegodmode.com', unsub, NOW);
    expect(mail.subject).toBe('Deine Agenten warten auf dich');
    expect(mail.text).toContain('Nichts wurde gelöscht');
    expect(mail.text).toContain('plan=yearly&trial=0&utm_source=email&utm_medium=free_ended');
  });
});
