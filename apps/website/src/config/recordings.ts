// Real screen recordings of Godmode (fresh install on a normal Mac, only cut and sped up). Files in public/media/rec/.
export type Recording = {
  slug: string;
  label: string;
  feature: string;
  icon: string;
  title: string;
  task: string;
  result: string;
  tools: string[];
  speed: string;
  recorded: string;
  src?: string;
};

export const RECORDINGS: Recording[] = [
  {
    slug: 'pricing-research',
    label: 'Research',
    feature: 'Reads websites for you',
    icon: 'search',
    title: 'Compares three price pages and answers with one table',
    task: 'Look up Notion, Linear and Slack pricing in the browser and give me one short table: what a 10-person team pays per month on the cheapest paid plan.',
    result: 'Notion Plus €95, Linear Basic $100, Slack Pro €67.50 per month for 10 people, checked on the live pricing pages.',
    tools: ['chrome', 'notion', 'slack'],
    speed: 'sped up',
    recorded: 'October 2026',
    src: '/media/hero',
  },
];
