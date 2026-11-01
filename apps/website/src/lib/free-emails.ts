import { PRICING, yearlySavings } from '@/config/site';
import { render, type Composed } from './lifecycle';

/** Emails to people on the app's free days who left their address in the app (leads with source 'app'). */
export type FreeEmailKind = 'free_welcome' | 'free_ending' | 'free_ended';

export type FreeLead = {
  id: number;
  email: string;
  free_ends_at: number | null;
  locale: string | null;
  unsubscribed_at: number | null;
};

const DAY = 86_400_000;

/** The `emails` row key of a lead (that table is keyed by checkout session for orders). */
export const leadKey = (id: number) => `lead:${id}`;

/**
 * What a lead is due for now, most urgent first: a welcome while more than 3 days are left, the reminder in the last
 * 3 days, and one note 1 to 3 days after the end. The caller sends each kind once and at most one mail a day.
 */
export function dueFreeKinds(l: FreeLead, now: number): FreeEmailKind[] {
  if (!l.free_ends_at || l.unsubscribed_at) return [];
  const left = l.free_ends_at - now;
  if (left > 3 * DAY) return ['free_welcome'];
  if (left > 0) return ['free_ending'];
  if (left <= -DAY && left > -3 * DAY) return ['free_ended'];
  return [];
}

const checkout = (base: string, plan: 'monthly' | 'yearly', medium: FreeEmailKind) =>
  `${base}/api/checkout?plan=${plan}&trial=0&utm_source=email&utm_medium=${medium}`;

/** Free-days emails in English or German (locale 'de'), written as Daniel. */
export function composeFree(kind: FreeEmailKind, l: FreeLead, base: string, unsubscribeUrl: string, now = Date.now()): Composed {
  const de = l.locale === 'de';
  const ends = l.free_ends_at ?? now;
  const date = new Date(ends).toLocaleDateString(de ? 'de-DE' : 'en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
  const days = Math.max(1, Math.ceil((ends - now) / DAY));
  const { monthly, yearly } = PRICING.plans;
  const guarantee = PRICING.guaranteeDays;
  const usd = (n: number) => (de ? `${n} $` : `$${n}`);
  const sign = de ? 'Daniel\nGründer, Godmode' : 'Daniel\nFounder, Godmode';
  const footer = de
    ? `Du bekommst diese Mail, weil du in Godmode um eine Erinnerung vor dem Ende deiner kostenlosen Tage gebeten hast. Abmelden: ${unsubscribeUrl}`
    : `You get this because you asked Godmode for a heads-up before your free days end. Unsubscribe: ${unsubscribeUrl}`;

  if (kind === 'free_welcome') {
    return de
      ? render(
          'Willkommen bei Godmode: 3 Dinge zum Ausprobieren',
          [
            'Hallo,',
            `danke, dass du Godmode ausprobierst. Bis zum ${date} kannst du alles kostenlos nutzen. Kurz vorher schreibe ich dir, damit dich nichts überrascht.`,
            'Drei gute erste Aufgaben. Tipp eine davon einfach so in Godmode ein:',
            '1. "Geh meinen Posteingang durch und liste die E-Mails auf, die ich heute beantworten sollte."\n2. "Melde dich bei meinen Lieferantenportalen an und lade die Rechnungen dieses Monats in einen Ordner."\n3. "Schreib mir jeden Freitag um 16 Uhr einen kurzen Wochenbericht aus meinem Kalender und meinen E-Mails."',
            'Alles, was du mehr als einmal pro Woche im Browser erledigst, passt gut. Bitte Godmode, es nach Zeitplan zu machen, dann bleibt es für dich dran.',
            'Wenn du nicht weiterkommst, antworte einfach auf diese Mail. Sie landet direkt bei mir.',
            sign,
          ],
          footer,
        )
      : render(
          'Welcome to Godmode: 3 things to try',
          [
            'Hi,',
            `thanks for trying Godmode. Everything is free until ${date}. I will send you a short note before then, so nothing catches you by surprise.`,
            'Three good first tasks. Type one into Godmode just like this:',
            '1. "Go through my inbox and list the emails I should answer today."\n2. "Log into my supplier portals and download this month\'s invoices into one folder."\n3. "Every Friday at 4pm, write me a short weekly report from my calendar and emails."',
            'Anything you do in a browser more than once a week is a good fit. Ask Godmode to do it on a schedule and it keeps doing it for you.',
            'If you get stuck, just reply to this email. It comes straight to me.',
            sign,
          ],
          footer,
        );
  }

  if (kind === 'free_ending') {
    return de
      ? render(
          days === 1 ? 'Dein kostenloses Godmode endet morgen' : `Dein kostenloses Godmode endet in ${days} Tagen`,
          [
            'Hallo,',
            `kurzer Hinweis: deine kostenlosen Tage mit Godmode enden am ${date}.`,
            'Mit einem Abo läuft alles einfach weiter: deine Agenten, ihre Zeitpläne, deine gespeicherten Logins und deine Chats. Du musst nichts neu einrichten.',
            `Godmode Pro kostet ${usd(monthly.price)} im Monat oder ${usd(yearly.perMonth)} im Monat bei jährlicher Zahlung. Wenn es sich für dich nicht lohnt, bekommst du dein Geld innerhalb von ${guarantee} Tagen zurück.`,
            { button: 'Godmode behalten', url: checkout(base, 'monthly', kind) },
            'Wenn etwas nicht so läuft, wie du gehofft hast, antworte mir. Ich lese jede Antwort.',
            sign,
          ],
          footer,
        )
      : render(
          days === 1 ? 'Your free Godmode ends tomorrow' : `Your free Godmode ends in ${days} days`,
          [
            'Hi,',
            `a quick heads-up: your free days with Godmode end on ${date}.`,
            'When you subscribe, everything keeps working: your agents, their schedules, your saved logins and your chats. Nothing to set up again.',
            `Godmode Pro is ${usd(monthly.price)} a month, or ${usd(yearly.perMonth)} a month billed yearly. If it does not pay off, you get your money back within ${guarantee} days.`,
            { button: 'Keep Godmode', url: checkout(base, 'monthly', kind) },
            'If something is not working the way you hoped, reply and tell me. I read every answer.',
            sign,
          ],
          footer,
        );
  }

  return de
    ? render(
        'Deine Agenten warten auf dich',
        [
          'Hallo,',
          `deine kostenlosen Tage mit Godmode sind am ${date} zu Ende gegangen.`,
          'Deine Agenten und Automationen sind noch da und warten. Nichts wurde gelöscht. Mit einem Abo machen sie genau da weiter, wo sie aufgehört haben.',
          { button: `Godmode behalten, ${usd(monthly.price)} im Monat`, url: checkout(base, 'monthly', kind) },
          `Oder jährlich für ${usd(yearly.perMonth)} im Monat (${usd(yearly.price)} im Jahr, ${yearlySavings} % gespart):\n${checkout(base, 'yearly', kind)}`,
          `${guarantee} Tage Geld-zurück-Garantie, jederzeit kündbar.`,
          'Wenn Godmode nicht das Richtige für dich war, würde ich gern wissen, warum. Antworte einfach, eine Zeile reicht.',
          sign,
        ],
        footer,
      )
    : render(
        'Your agents are waiting for you',
        [
          'Hi,',
          `your free days with Godmode ended on ${date}.`,
          'Your agents and automations are still there, waiting. Nothing was deleted. Subscribe and they pick up right where they stopped.',
          { button: `Keep Godmode, ${usd(monthly.price)} a month`, url: checkout(base, 'monthly', kind) },
          `Or pay yearly: ${usd(yearly.perMonth)} a month (${usd(yearly.price)} a year, save ${yearlySavings}%):\n${checkout(base, 'yearly', kind)}`,
          `${guarantee}-day money-back guarantee. Cancel any time.`,
          'If Godmode was not the right fit, I would love to know why. Just reply, one line is enough.',
          sign,
        ],
        footer,
      );
}
