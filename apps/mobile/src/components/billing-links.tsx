import { format } from "date-fns";
import { Linking } from "react-native";
import { useTranslation } from "react-i18next";
import type { CloudBilling } from "@godmode/shared";
import { Group, LinkRow } from "./form";
import { dateLocale, intlLocale } from "@/lib/i18n";

const open = (url: string) => void Linking.openURL(url).catch(() => undefined);

function money(minor: number, currency: string): string {
  try {
    const fmt = new Intl.NumberFormat(intlLocale(), { style: "currency", currency: currency.toUpperCase() });
    return fmt.format(minor / 10 ** (fmt.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Godmode Cloud's billing page and the invoices, opened in the browser like on the desktop. */
export function BillingLinks({ billing: b }: { billing: CloudBilling }) {
  const { t } = useTranslation("admin");
  if (!b.billingEnabled) return null;
  return (
    <Group title={t("billingExtra.invoices")}>
      <LinkRow icon="creditCard" title={t("billingExtra.portal")} chevron={false} onPress={() => open(b.urls.billing)} />
      {b.invoices.map((inv) => (
        <LinkRow
          key={inv.id}
          icon="doc"
          title={inv.number ?? format(new Date(inv.date), "PP", { locale: dateLocale() })}
          detail={inv.number ? format(new Date(inv.date), "PP", { locale: dateLocale() }) : undefined}
          value={money(inv.total, inv.currency)}
          chevron={false}
          onPress={() => (inv.url ?? inv.pdf ? open((inv.url ?? inv.pdf)!) : undefined)}
        />
      ))}
    </Group>
  );
}
