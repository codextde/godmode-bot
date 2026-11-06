/** Languages by their own names, like iOS lists them (the phone's JavaScript engine has no Intl.DisplayNames). */
const NAMES: Record<string, string> = {
  en: "English",
  "en-us": "English (US)",
  "en-gb": "English (UK)",
  de: "Deutsch",
  "de-de": "Deutsch",
  fr: "Français",
  "fr-fr": "Français",
  es: "Español",
  "es-es": "Español",
  it: "Italiano",
  "it-it": "Italiano",
  nl: "Nederlands",
  "nl-nl": "Nederlands",
  pl: "Polski",
  pt: "Português",
  "pt-br": "Português (Brasil)",
  tr: "Türkçe",
  sv: "Svenska",
  da: "Dansk",
  no: "Norsk",
  fi: "Suomi",
  cs: "Čeština",
  ro: "Română",
  el: "Ελληνικά",
  uk: "Українська",
  ru: "Русский",
  ar: "العربية",
  hi: "हिन्दी",
  ja: "日本語",
  "ja-jp": "日本語",
  ko: "한국어",
  zh: "中文",
};

export function languageName(tag: string): string {
  return NAMES[tag.toLowerCase()] ?? tag;
}
