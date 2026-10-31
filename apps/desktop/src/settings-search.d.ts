declare module "virtual:settings-search" {
  /** Labels and text of each settings section; "@key" is a key in the settings translations. */
  const index: Record<string, { labels: string[]; text: string[] }>;
  export default index;
}
