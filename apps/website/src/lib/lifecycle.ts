import { PRICING } from '@/config/site';

export type EmailKind = 'welcome' | 'day3' | 'trial_ending';

export type LifecycleOrder = {
  session_id: string;
  plan: string;
  email: string;
  name: string | null;
  license_key: string;
  amount_total: number | null;
  currency: string | null;
  customer_id: string | null;
  trial_end: number | null;
  first_seen_at: number | null;
};

export type Composed = { subject: string; text: string; html: string };

const DAY = 86_400_000;

/** Lifecycle emails an order is due for now, most urgent first. Each kind goes out once (the caller records it). */
export function dueKinds(o: LifecycleOrder & { created_at: number; sub_status: string | null; cancel_at_period_end: number | null }, now: number): EmailKind[] {
  const kinds: EmailKind[] = [];
  const trialing = o.sub_status === 'trialing';
  if (now - o.created_at < 14 * DAY) kinds.push('welcome');
  if (trialing && !o.cancel_at_period_end && o.trial_end && o.trial_end > now && o.trial_end - now <= 3 * DAY) kinds.push('trial_ending');
  if (trialing && now - o.created_at >= 3 * DAY && o.trial_end && o.trial_end - now > 3 * DAY) kinds.push('day3');
  return kinds;
}

const COMPANY = /\b(gmbh|ug|ag|kg|ohg|ltd|limited|inc|llc|corp|co|company|trade|shop|store|team|info)\b/i;
const firstName = (name: string | null) => {
  const first = name?.trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}'-]{2,30}$/u.test(first) && !COMPANY.test(name ?? '') ? first : '';
};

const longDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

function price(o: LifecycleOrder) {
  const plan = o.plan === 'yearly' ? PRICING.plans.yearly : PRICING.plans.monthly;
  return `$${plan.price}/${plan.interval}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Plain text is the source; the HTML part is the same words with links, no images or tracking. */
export function render(subject: string, paragraphs: string[]): Composed {
  const text = paragraphs.join('\n\n');
  const linkify = (p: string) => esc(p).replace(/https:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#0a7f5a">${u}</a>`);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fff;color:#111;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"><div style="max-width:560px">${paragraphs
    .map((p) => `<p style="margin:0 0 16px;white-space:pre-line">${linkify(p)}</p>`)
    .join('')}</div></body></html>`;
  return { subject, text, html };
}

export function compose(kind: EmailKind, o: LifecycleOrder, base: string): Composed {
  const hi = firstName(o.name) ? `Hi ${firstName(o.name)},` : 'Hi,';
  const download = `${base}/download?key=${o.license_key}`;
  const manage = o.customer_id ? `${base}/api/portal?key=${o.license_key}` : '';
  const sign = 'Daniel\nFounder, Godmode';
  const trialEnd = o.trial_end ? longDate(o.trial_end) : '';

  if (kind === 'welcome') {
    return render('Your Godmode license key', [
      hi,
      trialEnd ? 'thanks for starting your Godmode trial. Here is everything you need in one place.' : 'thanks for getting Godmode. Here is everything you need in one place.',
      `Your license key: ${o.license_key}`,
      `Download for Mac (your key is already filled in):\n${download}`,
      'Getting started takes about five minutes:\n1. Install Godmode and open it. Onboarding sets up Claude Code for you.\n2. Sign in with your Claude Pro or Max plan, or paste an Anthropic API key.\n3. Hand over your first task in one sentence, for example "Log into my Amazon account and download all invoices from this year into a folder."',
      'Reply with the three things you want Godmode to take off your plate, and I send you the exact messages to give it.',
      ...(trialEnd ? [`Your trial runs until ${trialEnd}. You can cancel any time${manage ? `, right here:\n${manage}` : ' by replying to this email.'}`] : []),
      'If anything gets stuck, just reply. This comes straight to me.',
      sign,
    ]);
  }

  if (kind === 'day3') {
    if (!o.first_seen_at) {
      return render('Did Godmode install OK?', [
        hi,
        'I noticed your Godmode key has not been activated yet, so I wanted to check if something got in the way.',
        `Here is your download again, with the key filled in. Open it on your Mac, not on your phone:\n${download}`,
        `Your key, in case you need to paste it: ${o.license_key}`,
        'If the install stopped somewhere, reply with a screenshot or one line about where, and I will help you get it running.',
        sign,
      ]);
    }
    return render('3 things to try with Godmode this week', [
      hi,
      'good to see Godmode running on your computer. Three good first tasks, each one message:',
      '1. "Every weekday at 8, go through my inbox and send me a short list of what needs an answer today."\n2. "Log into my supplier portals and download this month\'s invoices into one folder."\n3. "Find 20 companies that match my ideal customer, with website and contact, and put them in a spreadsheet."',
      'Anything you do in a browser more than once a week is a good candidate. Ask Godmode to turn it into an agent with a schedule and it keeps doing it for you.',
      'Tell me what you would like to automate first and I will send you the exact message to give it.',
      sign,
    ]);
  }

  return render(`Your Godmode trial ends on ${trialEnd}`, [
    hi,
    `a quick heads-up: your free trial ends on ${trialEnd}. After that your card is charged ${price(o)}.`,
    'Nothing to do if you want to keep going.',
    `If Godmode is not for you, cancel before ${trialEnd} and you will not be charged${manage ? `:\n${manage}` : ' (just reply to this email).'}`,
    `And if you stay but it does not pay off, the ${PRICING.guaranteeDays}-day money-back guarantee still applies after the first charge.`,
    'If something is not working the way you hoped, reply and tell me. I read every answer.',
    sign,
  ]);
}
