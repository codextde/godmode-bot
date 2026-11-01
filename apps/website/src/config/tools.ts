// Logos live in public/logos/<slug>.svg. Trademarks of their owners, shown to say Godmode works in these tools.
export type Tool = { slug: string; name: string };

export const TOOLS_OFFICE: Tool[] = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'outlook', name: 'Outlook' },
  { slug: 'excel', name: 'Excel' },
  { slug: 'word', name: 'Word' },
  { slug: 'google-sheets', name: 'Google Sheets' },
  { slug: 'google-drive', name: 'Google Drive' },
  { slug: 'google-calendar', name: 'Google Calendar' },
  { slug: 'teams', name: 'Teams' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'zoom', name: 'Zoom' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'whatsapp', name: 'WhatsApp Web' },
  { slug: 'dropbox', name: 'Dropbox' },
  { slug: 'trello', name: 'Trello' },
  { slug: 'asana', name: 'Asana' },
  { slug: 'airtable', name: 'Airtable' },
  { slug: 'chrome', name: 'Any website' },
];

export const TOOLS_BUSINESS: Tool[] = [
  { slug: 'shopify', name: 'Shopify' },
  { slug: 'etsy', name: 'Etsy' },
  { slug: 'paypal', name: 'PayPal' },
  { slug: 'stripe', name: 'Stripe' },
  { slug: 'quickbooks', name: 'QuickBooks' },
  { slug: 'xero', name: 'Xero' },
  { slug: 'datev', name: 'DATEV' },
  { slug: 'hubspot', name: 'HubSpot' },
  { slug: 'zendesk', name: 'Zendesk' },
  { slug: 'mailchimp', name: 'Mailchimp' },
  { slug: 'meta', name: 'Meta Ads' },
  { slug: 'google-ads', name: 'Google Ads' },
  { slug: 'tiktok', name: 'TikTok' },
  { slug: 'instagram', name: 'Instagram' },
  { slug: 'linkedin', name: 'LinkedIn' },
  { slug: 'canva', name: 'Canva' },
  { slug: 'wordpress', name: 'WordPress' },
];

export const TOOL_BY_SLUG = Object.fromEntries([...TOOLS_OFFICE, ...TOOLS_BUSINESS].map((t) => [t.slug, t]));
