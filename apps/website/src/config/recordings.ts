// Real screen recordings of Godmode (fresh demo install on a normal Mac, real runs, only cut and sped up).
// Files in public/media/rec/<slug>.{mp4,webm} + <slug>-poster.jpg, 1600x1000. `task` is what was typed, so it stays English.
type Text = { label: string; title: string; result: string; feature: string; realRun: string; speed: string };

export type Recording = {
  slug: string;
  icon: string;
  task: string;
  tools?: string[];
  en: Text;
  de: Text;
};

export const RECORDINGS: Recording[] = [
  {
    slug: 'vault-login',
    icon: 'key-round',
    task: 'Sign in to authenticationtest.com with my saved login, including the 2FA code, and tell me what the page says once I’m in.',
    tools: ['chrome'],
    en: {
      label: 'Logins and 2FA',
      title: 'Fills in password and 2FA from the vault. The AI only sees “Secret hidden”',
      result:
        'Signed in on the first try on a public test site. Godmode typed the saved username, password and 2FA code into the page itself; in the chat they show up only as “Secret hidden”.',
      feature: 'Password vault',
      realRun: '20 seconds',
      speed: 'almost real time',
    },
    de: {
      label: 'Logins und 2FA',
      title: 'Trägt Passwort und 2FA-Code aus dem Tresor ein. Die KI sieht nur „Secret hidden“',
      result:
        'Beim ersten Versuch auf einer öffentlichen Testseite angemeldet. Godmode hat Benutzername, Passwort und 2FA-Code selbst in die Seite getippt; im Chat stehen sie nur als „Secret hidden“.',
      feature: 'Passwort-Tresor',
      realRun: '20 Sekunden',
      speed: 'fast in Echtzeit',
    },
  },
  {
    slug: 'research-sheet',
    icon: 'file-spreadsheet',
    task: 'Use the browser to find 6 coworking spaces in Berlin with a day pass under 30 euros. Put name, area, day-pass price and website into a spreadsheet on my Desktop and show it to me.',
    tools: ['chrome', 'excel'],
    en: {
      label: 'Research',
      title: 'Researches six websites and hands you a spreadsheet',
      result: '6 coworking day passes from €15 to €25 with links, saved as an Excel file on the Desktop, plus where each price came from.',
      feature: 'Works in your browser',
      realRun: '3 min 21 s',
      speed: 'sped up 9x',
    },
    de: {
      label: 'Recherche',
      title: 'Recherchiert sechs Websites und gibt dir eine Tabelle',
      result: '6 Coworking-Tagespässe von 15 € bis 25 € mit Links, als Excel-Datei auf dem Schreibtisch, dazu woher jeder Preis stammt.',
      feature: 'Arbeitet in deinem Browser',
      realRun: '3 Min. 21 Sek.',
      speed: '9-fach beschleunigt',
    },
  },
  {
    slug: 'price-compare',
    icon: 'tag',
    task: 'Find the cheapest price for Apple AirPods Pro 3 at Amazon.de, MediaMarkt and Otto right now. One short table with links.',
    tools: ['chrome'],
    en: {
      label: 'Shopping',
      title: 'Compares the price in three online shops',
      result: 'Amazon.de €206.99, MediaMarkt €219.00, Otto €233.00, each with a link. Cookie banners and a wrong delivery country handled on the way.',
      feature: 'Works in your browser',
      realRun: '1 min 46 s',
      speed: 'sped up 4x',
    },
    de: {
      label: 'Einkaufen',
      title: 'Vergleicht den Preis in drei Onlineshops',
      result: 'Amazon.de 206,99 €, MediaMarkt 219,00 €, Otto 233,00 €, jeweils mit Link. Cookie-Banner und ein falsches Lieferland unterwegs selbst erledigt.',
      feature: 'Arbeitet in deinem Browser',
      realRun: '1 Min. 46 Sek.',
      speed: '4-fach beschleunigt',
    },
  },
  {
    slug: 'files',
    icon: 'folder-tree',
    task: 'Sort the invoices in my Downloads into folders by month and rename them to date_supplier_amount.pdf. Then give me a total per month.',
    en: {
      label: 'Files',
      title: 'Sorts and renames 15 messy invoice PDFs',
      result: '15 invoices in 3 month folders, renamed like 2026-10-23_Packhaus-GmbH_295.12.pdf, with a total per month: €4,165.42 overall.',
      feature: 'Works with files on your Mac',
      realRun: '24 seconds',
      speed: 'almost real time',
    },
    de: {
      label: 'Dateien',
      title: 'Sortiert und benennt 15 chaotische Rechnungs-PDFs um',
      result: '15 Rechnungen in 3 Monatsordnern, umbenannt wie 2026-10-23_Packhaus-GmbH_295.12.pdf, mit Summe pro Monat: 4.165,42 € insgesamt.',
      feature: 'Arbeitet mit Dateien auf deinem Mac',
      realRun: '24 Sekunden',
      speed: 'fast in Echtzeit',
    },
  },
  {
    slug: 'automation',
    icon: 'calendar-clock',
    task: 'Every Monday at 8:00, check the Hacker News front page and send me the 5 stories most useful for a small online business. Run it once now so I can see the first result.',
    en: {
      label: 'Every week',
      title: 'Turns one sentence into a weekly report',
      result: 'A Monday 08:00 automation, set up from that one sentence. The first run finished right away with 5 picks.',
      feature: 'Automations',
      realRun: '1 min 27 s',
      speed: 'sped up 4x',
    },
    de: {
      label: 'Jede Woche',
      title: 'Macht aus einem Satz einen Wochenbericht',
      result: 'Eine Automation für jeden Montag um 8:00, eingerichtet aus diesem einen Satz. Der erste Lauf war sofort fertig, mit 5 Treffern.',
      feature: 'Automationen',
      realRun: '1 Min. 27 Sek.',
      speed: '4-fach beschleunigt',
    },
  },
];
