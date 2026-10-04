"use client";

import { Gauge, Radio } from "lucide-react";
import { Callout, SettingsGroup } from "@/components/settings-kit";
import type { RelaySettings } from "@/server/settings/registry";
import { saveRelayAction } from "../actions";
import { NumberRow, SaveBar, SwitchRow, toNumber } from "./fields";
import { useSettingsForm } from "./use-settings-form";

type RelayFormValue = Omit<RelaySettings, "maxBodyMb" | "requestsPerMinute"> & { maxBodyMb: string; requestsPerMinute: string };

function toForm(s: RelaySettings): RelayFormValue {
  return { ...s, maxBodyMb: String(s.maxBodyMb), requestsPerMinute: String(s.requestsPerMinute) };
}

export function RelayForm({ initial }: { initial: RelaySettings }) {
  const form = useSettingsForm<RelayFormValue>(toForm(initial), async (v) => {
    const result = await saveRelayAction({ ...v, maxBodyMb: toNumber(v.maxBodyMb), requestsPerMinute: toNumber(v.requestsPerMinute) });
    return result.ok ? { ok: true, data: toForm(result.data) } : result;
  });
  const { value, set, fields } = form;

  return (
    <form onSubmit={form.submit} className="flex flex-col gap-5" noValidate>
      <SettingsGroup
        title="Relay"
        description="Linked computers keep one connection to this cloud; browsers and phones reach them through it. Each person's plan limits what they can use on top of these switches."
        icon={<Radio />}
      >
        <SwitchRow
          id="relay-enabled"
          label="Relay"
          description="Off: every linked computer is disconnected and nothing can be reached through this cloud until it is on again. Linking, accounts and billing keep working."
          checked={value.enabled}
          onChange={(v) => set("enabled", v)}
          error={fields.enabled}
        />
        <SwitchRow
          id="relay-browser"
          label="Open computers in the browser"
          description="The dashboard at /d/… for owners and people a computer is shared with. Off: the pages answer that this is turned off."
          checked={value.browserAccess}
          onChange={(v) => set("browserAccess", v)}
          disabled={!value.enabled}
          error={fields.browserAccess}
        />
        <SwitchRow
          id="relay-phone"
          label="Phone gateway"
          description="The Godmode phone app reaches a computer through this cloud with the computer's own pairing. Off: phones only work on the local network or over Tailscale."
          checked={value.phoneGateway}
          onChange={(v) => set("phoneGateway", v)}
          disabled={!value.enabled}
          error={fields.phoneGateway}
        />
        <SwitchRow
          id="relay-sharing"
          label="Sharing computers"
          description="People can give other accounts access to their computers. Off: no new shares, and existing shares stop working until it is on again."
          checked={value.sharing}
          onChange={(v) => set("sharing", v)}
          disabled={!value.enabled}
          error={fields.sharing}
        />
        {!value.enabled && (
          <div className="py-4">
            <Callout tone="warning" title="Saving disconnects every linked computer">
              They reconnect on their own as soon as the relay is on again.
            </Callout>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Limits" description="Protect the server from one computer or one browser taking everything." icon={<Gauge />}>
        <NumberRow
          id="relay-max-body"
          label="Largest request"
          description="Uploads to a computer (files, images in a chat) larger than this are refused before they travel. 1 to 2048 MB."
          unit="MB"
          min={1}
          max={2048}
          value={value.maxBodyMb}
          onChange={(v) => set("maxBodyMb", v)}
          error={fields.maxBodyMb}
        />
        <NumberRow
          id="relay-rpm"
          label="Requests per minute to one computer"
          description="Counted across everyone using that computer through the browser. Over the limit, requests get a “slow down” answer for the rest of the minute. 0 means no limit."
          unit="/ min"
          min={0}
          max={100_000}
          value={value.requestsPerMinute}
          onChange={(v) => set("requestsPerMinute", v)}
          error={fields.requestsPerMinute}
        />
      </SettingsGroup>

      <SaveBar form={form} />
    </form>
  );
}
