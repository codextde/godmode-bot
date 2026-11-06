import { useTranslation } from "react-i18next";
import { CONTEXT_BUDGET_CHOICES, DEFAULT_CONTEXT_BUDGET, compressChoice, compressPatch, tokensLabel, type RunnerSettings } from "@godmode/shared";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** When long chats are summarized: at a token budget (models work best well below their window), nearly full or never. */
export function CompressSelect({
  id,
  runner,
  onChange,
  className,
}: {
  id?: string;
  runner: Pick<RunnerSettings, "autoCompactPercent" | "contextBudget"> | undefined;
  onChange: (patch: ReturnType<typeof compressPatch>) => void;
  className?: string;
}) {
  const { t } = useTranslation("settings");
  const value = compressChoice(runner);
  const budgets: number[] = [...CONTEXT_BUDGET_CHOICES];
  if (/^\d+$/.test(value) && !budgets.includes(Number(value))) budgets.push(Number(value));
  budgets.sort((a, b) => a - b);
  return (
    <Select value={value} onValueChange={(v) => onChange(compressPatch(v))}>
      <SelectTrigger id={id} className={cn("w-44", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {budgets.map((b) => (
          <SelectItem key={b} value={String(b)}>
            {t(b === DEFAULT_CONTEXT_BUDGET ? "ai.limits.compactAtTokensDefault" : "ai.limits.compactAtTokens", { tokens: tokensLabel(b) })}
          </SelectItem>
        ))}
        {value.startsWith("p") && <SelectItem value={value}>{t("ai.limits.compactAt", { percent: Number(value.slice(1)) })}</SelectItem>}
        <SelectSeparator />
        <SelectItem value="claude">{t("ai.limits.compactNearlyFull")}</SelectItem>
        <SelectItem value="0">{t("ai.limits.compactNever")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
