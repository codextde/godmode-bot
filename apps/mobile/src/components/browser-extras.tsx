import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Linking } from "react-native";
import { useTranslation } from "react-i18next";
import { CAPTCHA_SOLVERS, type BrowserSettings, type CaptchaBalance, type CaptchaSolver, type CaptchaStatus } from "@godmode/shared";
import { FieldRow, Group, LinkRow, PickerRow, StepperRow, SwitchRow } from "./form";
import { InfoRow } from "./status-rows";
import { ActionRow, TextRow } from "./tool-form";
import { patchAnySettings } from "@/lib/admin";
import { errorText, request } from "@/lib/api";
import { intlLocale } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { fullVaultApi, vk } from "@/lib/vault";

/**
 * What the desktop's browser settings also have, for a phone with full access: CAPTCHA solving (the service's key is
 * sealed in the vault, write-only here) and the advanced paths.
 */
const SOLVERS: Record<Exclude<CaptchaSolver, "off">, { label: string; keyUrl: string; site: string; placeholder?: string }> = {
  "2captcha": { label: "2Captcha", keyUrl: "https://2captcha.com/enterpage", site: "2captcha.com" },
  capsolver: { label: "CapSolver", keyUrl: "https://dashboard.capsolver.com", site: "capsolver.com", placeholder: "CAP-…" },
  anticaptcha: { label: "Anti-Captcha", keyUrl: "https://anti-captcha.com/clients/settings/apisetup", site: "anti-captcha.com" },
};
const LIMITS = [0, 10, 25, 50, 100, 200, 500, 1000] as const;
const CAPTCHA_KEY = ["browser", "captcha"] as const;

const captchaApi = {
  status: () => request<CaptchaStatus>("GET", "/api/browser/captcha"),
  balance: () => request<CaptchaBalance>("POST", "/api/browser/captcha/balance", {}, 30_000),
};

const usd = (n: number) => `$${n.toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CaptchaGroup({ browser: b }: { browser: BrowserSettings }) {
  const { t } = useTranslation(["admin", "common"]);
  const status = useQuery({ queryKey: CAPTCHA_KEY, queryFn: captchaApi.status, staleTime: 30_000 });
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const solver = b.captchaSolver;
  const meta = solver === "off" ? null : SOLVERS[solver];
  const hasKey = !!status.data?.hasApiKey && status.data.solver === solver;
  const secretKey = status.data?.solver === solver ? status.data.secretKey : null;
  const limit = (n: number) => (n === 0 ? t("browserExtra.noLimit") : t("browserExtra.perDay", { count: n }));

  const pick = async (next: CaptchaSolver) => {
    setEditing(false);
    setKey("");
    setBalance(null);
    await patchAnySettings({ browser: { captchaSolver: next } });
    void queryClient.invalidateQueries({ queryKey: CAPTCHA_KEY });
  };

  const check = async () => {
    setChecking(true);
    try {
      setBalance(usd((await captchaApi.balance()).balance));
    } catch (err) {
      Alert.alert(t("browserExtra.balanceFailed"), errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!key.trim() || !secretKey || saving) return;
    setSaving(true);
    try {
      await fullVaultApi.setSecret(secretKey, key.trim());
      setKey("");
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: vk.secrets });
      await queryClient.invalidateQueries({ queryKey: CAPTCHA_KEY });
      void check();
    } catch (err) {
      Alert.alert(t("browserExtra.keyFailed"), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const options = [{ value: "off" as CaptchaSolver, label: t("common:status.off") }, ...CAPTCHA_SOLVERS.filter((s) => s !== "off").map((s) => ({ value: s, label: SOLVERS[s].label }))];
  const steps = LIMITS.includes(b.captchaDailyLimit as (typeof LIMITS)[number]) ? LIMITS : [...LIMITS, b.captchaDailyLimit].sort((x, y) => x - y);

  return (
    <Group title={t("browserExtra.captcha")} footer={meta && status.data ? t("browserExtra.solvedToday", { count: status.data.solvedToday }) : undefined}>
      <SwitchRow icon="cursor" title={t("browserExtra.local")} disabled={!b.enabled} value={b.captchaLocal} onChange={(captchaLocal) => void patchAnySettings({ browser: { captchaLocal } })} />
      <PickerRow icon="puzzle" title={t("browserExtra.service")} value={solver} options={options} onChange={(next) => void pick(next)} />
      {meta && hasKey ? (
        <InfoRow
          icon="key"
          label={t("browserExtra.apiKey", { service: meta.label })}
          value={t("browserExtra.set")}
          tone="success"
          detail={balance ? t("browserExtra.balance", { amount: balance }) : undefined}
        />
      ) : null}
      {meta && secretKey && (editing || !hasKey) ? <TextRow label={t("browserExtra.apiKey", { service: meta.label })} value={key} onChange={setKey} placeholder={meta.placeholder} secure stacked /> : null}
      {meta && secretKey && (editing || !hasKey) ? <ActionRow icon="check" title={t("browserExtra.saveKey")} busy={saving} onPress={() => void save()} /> : null}
      {meta && hasKey && !editing ? <ActionRow icon="pencil" title={t("browserExtra.replaceKey")} onPress={() => setEditing(true)} /> : null}
      {meta && hasKey ? <ActionRow icon="dollar" title={t("browserExtra.checkBalance")} busy={checking} onPress={() => void check()} /> : null}
      {meta ? <LinkRow icon="external" title={t("browserExtra.getKey", { site: meta.site })} chevron={false} onPress={() => void Linking.openURL(meta.keyUrl).catch(() => undefined)} /> : null}
      {meta ? (
        <StepperRow
          icon="gauge"
          title={t("browserExtra.dailyLimit")}
          value={b.captchaDailyLimit}
          min={0}
          max={steps[steps.length - 1]!}
          steps={steps}
          format={limit}
          onChange={(captchaDailyLimit) => void patchAnySettings({ browser: { captchaDailyLimit } })}
        />
      ) : null}
    </Group>
  );
}

/** Paths for when auto-detection picks the wrong program; empty means automatic. */
export function BrowserAdvancedGroup({ browser: b }: { browser: BrowserSettings }) {
  const { t } = useTranslation("admin");
  return (
    <Group title={t("browserExtra.advanced")}>
      <FieldRow label={t("browserExtra.chromePath")} value={b.chromePath} placeholder={t("browserExtra.automatic")} stacked onCommit={(chromePath) => void patchAnySettings({ browser: { chromePath: chromePath.trim() } })} />
      <FieldRow
        label={t("browserExtra.command")}
        value={b.browserUseCommand}
        placeholder={t("browserExtra.automatic")}
        stacked
        onCommit={(browserUseCommand) => void patchAnySettings({ browser: { browserUseCommand: browserUseCommand.trim() } })}
      />
    </Group>
  );
}
