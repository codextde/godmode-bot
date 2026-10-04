"use client";

import { Megaphone, Scale, SlidersHorizontal } from "lucide-react";
import { Segmented } from "@/components/controls";
import { SettingRow, SettingsGroup } from "@/components/settings-kit";
import { Textarea } from "@/components/ui/textarea";
import type { GeneralSettings } from "@/server/settings/registry";
import { saveGeneralAction } from "../actions";
import { SaveBar, TextRow } from "./fields";
import { useSettingsForm } from "./use-settings-form";

const ANNOUNCEMENT_MAX = 280;

export function GeneralForm({ initial }: { initial: GeneralSettings }) {
  const form = useSettingsForm<GeneralSettings>(initial, saveGeneralAction);
  const { value, set, fields } = form;

  return (
    <form onSubmit={form.submit} className="flex flex-col gap-5" noValidate>
      <SettingsGroup title="General" description="How this cloud names itself and where people get help." icon={<SlidersHorizontal />}>
        <TextRow
          id="general-app-name"
          label="Name"
          description="Shown in the browser tab, the sidebar and every e-mail."
          value={value.appName}
          onChange={(v) => set("appName", v)}
          error={fields.appName}
          maxLength={60}
          autoComplete="off"
        />
        <TextRow
          id="general-support-email"
          label="Support e-mail"
          description="Shown as “Contact” in the footer and in e-mails. Leave empty to show none."
          type="email"
          inputMode="email"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="help@example.com"
          value={value.supportEmail}
          onChange={(v) => set("supportEmail", v)}
          error={fields.supportEmail}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Legal links"
        description="Linked in the footer of the sign-in page, the app and every e-mail. Empty links are left out."
        icon={<Scale />}
      >
        <TextRow
          id="general-terms"
          label="Terms"
          description="Also needed before checkout can ask people to accept your terms."
          type="url"
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://example.com/terms"
          value={value.termsUrl}
          onChange={(v) => set("termsUrl", v)}
          error={fields.termsUrl}
        />
        <TextRow
          id="general-privacy"
          label="Privacy policy"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://example.com/privacy"
          value={value.privacyUrl}
          onChange={(v) => set("privacyUrl", v)}
          error={fields.privacyUrl}
        />
        <TextRow
          id="general-imprint"
          label="Imprint"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://example.com/imprint"
          value={value.imprintUrl}
          onChange={(v) => set("imprintUrl", v)}
          error={fields.imprintUrl}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Announcement"
        description="A bar at the top of the app and the sign-in page, for everyone, until you clear it."
        icon={<Megaphone />}
      >
        <SettingRow
          label="Text"
          htmlFor="general-announcement"
          stacked
          description={
            <>
              Leave empty to show no bar.
              {fields.announcement && (
                <span id="general-announcement-error" role="alert" className="mt-1 block text-destructive">
                  {fields.announcement}
                </span>
              )}
            </>
          }
        >
          <Textarea
            id="general-announcement"
            value={value.announcement}
            onChange={(e) => set("announcement", e.target.value)}
            maxLength={ANNOUNCEMENT_MAX}
            rows={2}
            placeholder="Maintenance on Saturday from 8 to 9 UTC."
            aria-invalid={fields.announcement ? true : undefined}
            aria-describedby={fields.announcement ? "general-announcement-error" : undefined}
          />
          <p className="mt-1.5 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
            {value.announcement.length} / {ANNOUNCEMENT_MAX}
          </p>
        </SettingRow>
        <SettingRow label="Tone" description="Warning draws more attention; use it for outages and deadlines.">
          <Segmented
            aria-label="Announcement tone"
            value={value.announcementTone}
            onChange={(v) => set("announcementTone", v)}
            options={[
              { value: "info", label: "Info" },
              { value: "warning", label: "Warning" },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SaveBar form={form} />
    </form>
  );
}
