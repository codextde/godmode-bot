// Real screen recordings of Godmode 0.2.41 (fresh install on a normal Mac, real runs, only cut and sped up).
// Files in public/media/rec/<slug>.{mp4,webm} + <slug>-poster.jpg, 1600x1000.
export type Recording = {
  slug: string;
  label: string;
  icon: string;
  title: string;
  task: string;
  result: string;
  feature: string;
  realRun: string;
  speed: string;
  tools?: string[];
};

export const RECORDINGS: Recording[] = [
  {
    slug: 'vault-login',
    label: 'Logins and 2FA',
    icon: 'key-round',
    title: 'Signs in with password and 2FA code, without ever seeing them',
    task: 'Sign in to authenticationtest.com with my saved login, including the 2FA code, and tell me what the page says once I’m in.',
    result:
      'Signed in on the first try. Username, password and 2FA code came from the encrypted vault and show up only as “Secret hidden”.',
    feature: 'Password vault',
    realRun: '20 seconds',
    speed: 'almost real time',
    tools: ['chrome'],
  },
  {
    slug: 'research-sheet',
    label: 'Research',
    icon: 'file-spreadsheet',
    title: 'Researches six websites and hands you a spreadsheet',
    task: 'Use the browser to find 6 coworking spaces in Berlin with a day pass under 30 euros. Put name, area, day-pass price and website into a spreadsheet on my Desktop and show it to me.',
    result:
      '6 coworking day passes from €15 to €25 with links, saved as an Excel file on the Desktop, plus where each price came from.',
    feature: 'Works in your browser',
    realRun: '3 min 21 s',
    speed: 'sped up 9x',
    tools: ['chrome', 'excel'],
  },
  {
    slug: 'price-compare',
    label: 'Shopping',
    icon: 'tag',
    title: 'Compares the price in three online shops',
    task: 'Find the cheapest price for Apple AirPods Pro 3 at Amazon.de, MediaMarkt and Otto right now. One short table with links.',
    result: 'Amazon.de €206.99, MediaMarkt €219.00, Otto €233.00, each with a link. Cookie banners and a wrong delivery country handled on the way.',
    feature: 'Works in your browser',
    realRun: '1 min 46 s',
    speed: 'sped up 4x',
    tools: ['chrome'],
  },
  {
    slug: 'files',
    label: 'Files',
    icon: 'folder-tree',
    title: 'Sorts and renames 15 messy invoice PDFs',
    task: 'Sort the invoices in my Downloads into folders by month and rename them to date_supplier_amount.pdf. Then give me a total per month.',
    result: '15 invoices in 3 month folders, renamed like 2026-10-23_Packhaus-GmbH_295.12.pdf, with a total per month: €4,165.42 overall.',
    feature: 'Works with files on your Mac',
    realRun: '24 seconds',
    speed: 'almost real time',
  },
  {
    slug: 'automation',
    label: 'Every week',
    icon: 'calendar-clock',
    title: 'Turns one sentence into a weekly report',
    task: 'Every Monday at 8:00, check the Hacker News front page and send me the 5 stories most useful for a small online business. Run it once now so I can see the first result.',
    result: 'A Monday 08:00 automation, set up from that one sentence. The first run finished right away with 5 picks.',
    feature: 'Automations',
    realRun: '1 min 27 s',
    speed: 'sped up 4x',
  },
];
