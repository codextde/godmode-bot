import { Alert, View } from "react-native";
import { useTranslation } from "react-i18next";
import { toE164, type Settings } from "@godmode/shared";
import { useFullAccess } from "./admin";
import { PinGroup, TestCallRow } from "./call-setup";
import { FieldRow, Group, PickerRow, SwitchRow, TextEditor } from "./form";
import { SectionTitle } from "./ui";
import { patchAnySettings } from "@/lib/admin";
import { useAgents } from "@/lib/hooks";
import { space } from "@/lib/theme";

type Phone = Settings["phone"];

/** What the desktop also sets for calls, on a phone with full access: your number, calls to you, the PIN and answering. */
export function CallsAdmin({ phone: p }: { phone: Phone }) {
  const { t } = useTranslation("admin");
  const { fullAccess } = useFullAccess();
  const agents = useAgents().data ?? [];
  if (!fullAccess) return null;
  const set = (phone: Partial<Phone>, quiet = false) => patchAnySettings({ phone }, { quiet });

  const saveNumber = (raw: string) => {
    if (!raw.trim()) return void set({ ownerNumber: "" });
    const number = toE164(raw);
    if (!number) return Alert.alert(t("calls.invalidNumber"));
    if (number !== p.ownerNumber) void set({ ownerNumber: number });
  };
  const agentOptions = [{ value: "", label: t("calls.defaultAgent") }, ...agents.filter((a) => a.enabled || a.id === p.inboundAgentId).map((a) => ({ value: a.id, label: a.name }))];

  return (
    <>
      <Group title={t("calls.ownerTitle")}>
        <FieldRow label={t("calls.number")} value={p.ownerNumber} placeholder="+49 151 12345678" keyboardType="phone-pad" maxLength={24} onCommit={saveNumber} />
        <SwitchRow icon="callOut" title={t("calls.allow")} value={p.callOwner} disabled={!p.ownerNumber} onChange={(callOwner) => void set({ callOwner })} />
        {p.ownerNumber ? <TestCallRow phone={p} /> : null}
      </Group>

      <PinGroup />

      <Group title={t("calls.inboundTitle")}>
        <SwitchRow icon="callIn" title={t("calls.answer")} value={p.answerInbound} onChange={(answerInbound) => void set({ answerInbound })} />
        <PickerRow icon="agents" title={t("calls.agent")} value={p.inboundAgentId} options={agentOptions} onChange={(inboundAgentId) => void set({ inboundAgentId })} />
      </Group>

      <View style={{ gap: space.sm }}>
        <SectionTitle title={t("calls.instructions")} />
        <TextEditor
          label={t("calls.instructions")}
          value={p.inboundInstructions}
          placeholder={t("calls.instructionsPlaceholder")}
          minHeight={110}
          maxLength={4000}
          onSave={(inboundInstructions) => set({ inboundInstructions: inboundInstructions.trim() }, true)}
        />
      </View>
    </>
  );
}
