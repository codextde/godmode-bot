import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { CallSetup, Settings } from "@godmode/shared";
import { confirmWithBiometrics, isRefused } from "./admin";
import { Group, LinkRow, PickerRow } from "./form";
import { InfoRow } from "./status-rows";
import { ActionRow } from "./tool-form";
import { patchAnySettings } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { callsAdmin, ck, useCallSetup, usePinStatus } from "@/lib/calls-admin";
import { queryClient } from "@/lib/query";

type Phone = Settings["phone"];

const set = (phone: Partial<Phone>) => patchAnySettings({ phone });

/** Whether calls can be placed now, and what to fix if not (ElevenLabs is asked again on a tap). */
export function CallStatusGroup() {
  const { t } = useTranslation("admin");
  const setup = useCallSetup();
  const s = setup.data;
  const source = s?.keySource === "vault" ? t("callSetup.keyVault") : s?.keySource === "api_tool" ? t("callSetup.keyApiTool") : null;
  const detail = !s
    ? setup.isError
      ? errorText(setup.error)
      : undefined
    : s.ready
      ? [source, t("callSetup.numbers", { count: s.numbers.length }), t("callSetup.voices", { count: s.voices.length })].filter(Boolean).join(" · ")
      : s.problems.join("\n");
  const value = setup.isPending ? t("callSetup.checking") : !s ? t("callSetup.unreachable") : s.ready ? t("callSetup.ready") : t("callSetup.notReady");
  return (
    <Group>
      <InfoRow icon="call" label={t("callSetup.status")} value={value} tone={setup.isPending ? undefined : s?.ready ? "success" : "warning"} detail={detail} />
      <ActionRow icon="refresh" title={t("callSetup.checkAgain")} busy={setup.isFetching} onPress={() => void setup.refetch()} />
    </Group>
  );
}

/** The number calls go out from (the account's first by default) and a Twilio number brought in. */
export function NumberGroup({ phone: p }: { phone: Phone }) {
  const { t } = useTranslation("admin");
  const setup = useCallSetup();
  const numbers = setup.data?.numbers ?? [];
  const first = numbers[0];
  const options = [
    { value: "", label: first ? first.number : t("callSetup.firstNumber"), detail: t("callSetup.firstInAccount") },
    ...numbers.slice(1).map((n) => ({ value: n.id, label: n.number, detail: n.label || undefined })),
    ...(p.numberId && !numbers.some((n) => n.id === p.numberId) ? [{ value: p.numberId, label: setup.data ? t("callSetup.numberGone") : p.numberId }] : []),
  ];
  return (
    <Group title={t("callSetup.numberTitle")}>
      {numbers.length ? (
        <PickerRow icon="phone" title={t("callSetup.from")} value={p.numberId} options={options} onChange={(numberId) => void set({ numberId })} />
      ) : (
        <InfoRow icon="phone" label={t("callSetup.from")} value={setup.isPending ? t("callSetup.checking") : t("callSetup.noNumber")} />
      )}
      <LinkRow icon="plus" title={t("callSetup.importTwilio")} onPress={() => router.push("/settings/call-number")} />
    </Group>
  );
}

/** Rows for the voice group: the ElevenLabs voice (with its sample) and the model that talks; none without full access. */
export function useVoiceRows(phone: Phone | undefined, enabled: boolean) {
  const { t } = useTranslation("admin");
  const setup = useCallSetup(enabled);
  const s: CallSetup | undefined = setup.data;
  const voices = s?.voices ?? [];
  const voiceId = phone?.voiceId ?? "";
  const voice = voices.find((v) => v.id === voiceId);
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [sampleOf, setSampleOf] = useState<string | null>(null);
  const playing = status.playing && !!voice && sampleOf === voice.id;

  // A new voice stops the sample of the old one.
  useEffect(() => {
    player.pause();
  }, [voiceId, player]);

  const preview = async () => {
    if (playing) return player.pause();
    if (!voice?.previewUrl) return;
    await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
    if (sampleOf !== voice.id) player.replace({ uri: voice.previewUrl });
    else await player.seekTo(0);
    setSampleOf(voice.id);
    player.play();
  };

  if (!enabled || !phone) return [];
  const p = phone;
  const llms = s?.llms.length ? s.llms : [p.llm];
  const voiceOptions = [
    { value: "", label: t("callSetup.defaultVoice") },
    ...voices.map((v) => ({ value: v.id, label: v.name, detail: v.description || undefined })),
    ...(p.voiceId && !voice ? [{ value: p.voiceId, label: s ? t("callSetup.voiceGone") : p.voiceId }] : []),
  ];
  const modelOptions = (llms.includes(p.llm) ? llms : [p.llm, ...llms]).map((m) => ({ value: m, label: m }));

  return [
    <PickerRow key="voice" icon="waveform" title={t("callSetup.voice")} detail={voice?.description || undefined} value={p.voiceId} options={voiceOptions} onChange={(next) => void set({ voiceId: next })} />,
    ...(voice?.previewUrl
      ? [<ActionRow key="sample" icon={playing ? "stop" : "play"} title={playing ? t("callSetup.stopSample") : t("callSetup.playSample")} onPress={() => void preview()} />]
      : []),
    <PickerRow key="model" icon="sparkles" title={t("callSetup.model")} value={p.llm} options={modelOptions} onChange={(llm) => void set({ llm })} />,
  ];
}

/** A test call to the owner's number, placed right away. */
export function TestCallRow({ phone: p }: { phone: Phone }) {
  const { t } = useTranslation(["admin", "components"]);
  const [busy, setBusy] = useState(false);
  const call = async () => {
    if (!p.ownerNumber) return Alert.alert(t("callSetup.testNeedsNumber"));
    setBusy(true);
    try {
      await callsAdmin.test();
      void queryClient.invalidateQueries({ queryKey: ["calls"] });
      Alert.alert(t("callSetup.testPlaced"));
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("callSetup.testFailed"), isRefused(err) ? undefined : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return <ActionRow icon="callOut" title={busy ? t("callSetup.calling") : t("callSetup.testCall")} busy={busy} onPress={() => void call()} />;
}

/**
 * The owner's PIN: callers who say it are the owner on incoming calls. It is never shown or sent back; setting it
 * (on its own screen) and removing it take Face ID first.
 */
export function PinGroup() {
  const { t } = useTranslation(["admin", "common"]);
  const status = usePinStatus();
  const on = !!status.data?.set;
  const locked = status.data?.lockedUntil;

  const remove = () =>
    Alert.alert(t("callSetup.pinRemoveTitle"), t("callSetup.pinRemoveBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("callSetup.pinRemove"),
        style: "destructive",
        onPress: async () => {
          if (!(await confirmWithBiometrics(t("callSetup.pinRemove")))) return;
          try {
            queryClient.setQueryData(ck.pin, await callsAdmin.removePin());
          } catch (err) {
            Alert.alert(t("callSetup.pinFailed"), errorText(err));
          }
        },
      },
    ]);

  return (
    <Group title={t("callSetup.pinTitle")} footer={status.data ? (on ? t("callSetup.pinOn") : t("callSetup.pinOff")) : undefined}>
      <InfoRow
        icon="lock"
        label={t("callSetup.pinLabel")}
        value={status.isPending ? undefined : on ? t("common:status.on") : t("common:status.off")}
        tone={on ? "success" : undefined}
        detail={locked ? t("callSetup.pinLocked", { time: new Date(locked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : undefined}
      />
      <ActionRow icon="key" title={on ? t("callSetup.pinChange") : t("callSetup.pinSet")} onPress={() => router.push("/settings/call-pin")} />
      {on ? <ActionRow icon="trash" title={t("callSetup.pinRemove")} tone="danger" onPress={remove} /> : null}
    </Group>
  );
}
