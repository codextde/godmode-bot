import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, AudioLines, CircleCheck, Hash, Phone, PhoneCall, PhoneIncoming, PhoneOutgoing, Play, Plus, RefreshCw, Square, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import type { CallSetup, PhoneSettings, Settings } from "@godmode/shared";
import { isClockTime, toE164 } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { CALL_LANGUAGES } from "@/components/calls/call-parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/vault/password-input";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { useAllAgents } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { FeaturePageLink, FeatureSection } from "./feature-section";
import { Callout, CommitInput, CommitTextarea, NumberField, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

const FIRST_NUMBER = "__first";
const DEFAULT_VOICE = "__default";
const DEFAULT_AGENT = "__default";

const KEY_SOURCE = {
  vault: { labelKey: "calls.keySource.vault", usingKey: "calls.keySource.usingVault" },
  api_tool: { labelKey: "calls.keySource.apiTool", usingKey: "calls.keySource.usingApiTool" },
} as const satisfies Record<NonNullable<CallSetup["keySource"]>, { labelKey: string; usingKey: string }>;

export function useCallSetup() {
  return useQuery({ queryKey: qk.callSetup, queryFn: api.calls.setup, staleTime: 60_000, retry: 1 });
}

export function CallsSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation(["settings", "common"]);
  const { patch } = useSettingsPatch();
  const qc = useQueryClient();
  const p = settings.phone;
  const set = (x: Partial<PhoneSettings>) => patch({ phone: x });
  const setup = useCallSetup();
  const s = setup.data;

  const test = useMutation({
    mutationFn: api.calls.test,
    onSuccess: () => {
      toast.success(t("calls.testToast"), { description: t("calls.testToastDescription") });
      void qc.invalidateQueries({ queryKey: qk.calls });
    },
    onError: (e) => toastApiError(e, t("calls.testError"), qc),
  });

  const saveOwnerNumber = (raw: string) => {
    if (!raw.trim()) {
      if (p.ownerNumber) set({ ownerNumber: "" });
      return;
    }
    const number = toE164(raw);
    if (!number) {
      toast.error(t("calls.invalidNumber"), { description: t("calls.invalidNumberDescription") });
      return;
    }
    if (number !== p.ownerNumber) set({ ownerNumber: number });
  };

  const saveQuiet = (key: "quietFrom" | "quietTo", v: string) => {
    if (v === "" || isClockTime(v)) set({ [key]: v });
  };

  return (
    <FeatureSection
      feature="phone"
      settings={settings}
      title={t("calls.title")}
      summary={t("calls.summary")}
      icon={<Phone />}
      offNote={t("calls.offNote")}
      points={[
        { icon: <PhoneOutgoing />, text: t("calls.pointOutgoing") },
        { icon: <UserRound />, text: t("calls.pointOwner") },
        { icon: <PhoneIncoming />, text: t("calls.pointIncoming") },
      ]}
    >
      <div className="space-y-5">
        <SetupStatus setup={setup} />

        <FeaturePageLink to="/calls" icon={<Phone />} title={t("calls.openCalls")} description={t("calls.openCallsDescription")} />

        <NumberGroup settings={settings} setup={s} loading={setup.isPending} />

        <SettingsGroup
          title={t("calls.owner.title")}
          icon={<UserRound />}
          description={t("calls.owner.description")}
          actions={
            <Button size="sm" variant="outline" disabled={!p.enabled || !p.ownerNumber || test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? <Spinner /> : <PhoneCall />} {t("calls.owner.test")}
            </Button>
          }
        >
          <SettingRow label={t("calls.owner.number")} htmlFor="calls-owner" description={t("calls.owner.numberDescription")}>
            <CommitInput
              id="calls-owner"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              className="w-56 font-mono text-[13px]"
              placeholder="+49 151 12345678"
              delay={null}
              value={p.ownerNumber}
              onCommit={saveOwnerNumber}
            />
          </SettingRow>
          <SettingRow
            label={t("calls.owner.allow")}
            htmlFor="calls-owner-on"
            disabled={!p.ownerNumber}
            description={t("calls.owner.allowDescription")}
          >
            <Switch id="calls-owner-on" checked={p.callOwner} disabled={!p.ownerNumber} onCheckedChange={(callOwner) => set({ callOwner })} />
          </SettingRow>
          <SettingRow
            label={t("calls.owner.quiet")}
            disabled={!p.ownerNumber || !p.callOwner}
            description={
              p.quietFrom && p.quietTo
                ? t("calls.owner.quietSet", { from: p.quietFrom, to: p.quietTo })
                : t("calls.owner.quietNone")
            }
          >
            <div className="flex items-center gap-2">
              <CommitInput
                type="time"
                aria-label={t("calls.owner.quietFrom")}
                className="w-28 tabular-nums"
                value={p.quietFrom}
                onCommit={(v) => saveQuiet("quietFrom", v)}
              />
              <span className="text-xs text-muted-foreground">{t("calls.owner.to")}</span>
              <CommitInput type="time" aria-label={t("calls.owner.quietUntil")} className="w-28 tabular-nums" value={p.quietTo} onCommit={(v) => saveQuiet("quietTo", v)} />
              {(p.quietFrom || p.quietTo) && (
                <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => set({ quietFrom: "", quietTo: "" })}>
                  {t("calls.owner.clear")}
                </Button>
              )}
            </div>
          </SettingRow>
        </SettingsGroup>

        <VoiceGroup settings={settings} setup={s} />

        <InboundGroup settings={settings} />
      </div>
    </FeatureSection>
  );
}

function SetupStatus({ setup }: { setup: ReturnType<typeof useCallSetup> }) {
  const { t } = useTranslation("settings");
  const s = setup.data;
  const retry = (
    <Button size="xs" variant="ghost" className="-ml-2 text-foreground" disabled={setup.isFetching} onClick={() => setup.refetch()}>
      {setup.isFetching ? <Spinner /> : <RefreshCw />} {t("botCheck.again")}
    </Button>
  );
  if (setup.isPending) return <Callout tone="muted" icon={<Spinner className="text-muted-foreground" />} title={t("calls.setup.checking")} />;
  if (setup.isError || !s)
    return (
      <Callout tone="warning" title={t("calls.setup.unreachable")}>
        <p>{errorMessage(setup.error)}</p>
        {retry}
      </Callout>
    );
  const source = s.keySource ? KEY_SOURCE[s.keySource] : null;
  if (s.ready)
    return (
      <Callout tone="info" icon={<CircleCheck className="text-emerald-600 dark:text-emerald-400" />} title={t("calls.setup.ready")}>
        <p>
          {source && t(source.labelKey)} · {t("calls.setup.numbers", { count: s.numbers.length })} · {t("calls.setup.voices", { count: s.voices.length })}
        </p>
        {retry}
      </Callout>
    );
  return (
    <Callout tone="warning" title={t("calls.setup.notReady")}>
      <ul className="list-disc space-y-0.5 pl-4">
        {s.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <p className="mt-1.5">
        {source ? t(source.usingKey) : <Trans t={t} i18nKey="calls.setup.noKey" components={{ link: <Link to="/settings/api-keys" className="font-medium text-primary underline-offset-2 hover:underline" /> }} />}
      </p>
      {retry}
    </Callout>
  );
}

function NumberGroup({ settings, setup, loading }: { settings: Settings; setup: CallSetup | undefined; loading: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const { patch } = useSettingsPatch();
  const qc = useQueryClient();
  const p = settings.phone;
  const numbers = setup?.numbers ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ number: "", label: "", sid: "", token: "" });
  const number = toE164(form.number);
  const ready = !!number && !!form.sid.trim() && !!form.token.trim();

  const importNumber = useMutation({
    mutationFn: () => api.calls.importNumber({ number: number!, label: form.label.trim() || undefined, sid: form.sid.trim(), token: form.token.trim() }),
    onSuccess: (next) => {
      qc.setQueryData(qk.callSetup, next);
      toast.success(t("calls.number.imported"), { description: t("calls.number.importedDescription", { number }) });
      setForm({ number: "", label: "", sid: "", token: "" });
      setAdding(false);
    },
    onError: (e) => toastApiError(e, t("calls.number.importError"), qc),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !importNumber.isPending) importNumber.mutate();
  };

  const first = numbers[0];
  return (
    <SettingsGroup
      title={t("calls.number.title")}
      icon={<Hash />}
      description={t("calls.number.description")}
      actions={
        !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus /> {t("calls.number.importTwilio")}
          </Button>
        )
      }
    >
      <SettingRow
        label={t("calls.number.from")}
        htmlFor="calls-number"
        description={loading ? t("calls.number.loading") : numbers.length ? undefined : t("calls.number.none")}
      >
        <Select value={p.numberId || FIRST_NUMBER} onValueChange={(v) => patch({ phone: { numberId: v === FIRST_NUMBER ? "" : v } })} disabled={!numbers.length}>
          <SelectTrigger id="calls-number" className="w-64">
            <SelectValue placeholder={t("calls.number.noneYet")} />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value={FIRST_NUMBER}>
              <span className="font-mono text-[13px]">{first?.number ?? t("calls.number.first")}</span>
              <span className="text-xs text-muted-foreground">· {t("calls.number.firstInAccount")}</span>
            </SelectItem>
            {numbers.length > 1 && <SelectSeparator />}
            {numbers.slice(1).map((n) => (
              <SelectItem key={n.id} value={n.id}>
                <span className="font-mono text-[13px]">{n.number}</span>
                {n.label && <span className="text-xs text-muted-foreground">· {n.label}</span>}
              </SelectItem>
            ))}
            {p.numberId && !numbers.some((n) => n.id === p.numberId) && (
              <SelectItem value={p.numberId}>
                <span className="text-muted-foreground">{t("calls.number.gone")}</span>
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </SettingRow>

      {adding && (
        <form onSubmit={submit} className="space-y-3 py-4">
          <div className="grid gap-3 @xl:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="import-number">{t("calls.number.title")}</Label>
              <Input
                id="import-number"
                type="tel"
                value={form.number}
                onChange={(e) => setForm({ ...form, number: e.target.value })}
                placeholder="+1 415 555 0123"
                autoComplete="off"
                className="font-mono text-[13px]"
                aria-invalid={!!form.number.trim() && !number}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="import-label">{t("calls.number.label")}</Label>
              <Input id="import-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={t("calls.number.labelPlaceholder")} autoComplete="off" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="import-sid">Account SID</Label>
              <Input
                id="import-sid"
                value={form.sid}
                onChange={(e) => setForm({ ...form, sid: e.target.value })}
                placeholder="AC…"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-[13px]"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="import-token">Auth Token</Label>
              <PasswordInput id="import-token" groupClassName="h-9" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder={t("calls.number.tokenPlaceholder")} />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("calls.number.tokenNote")}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!ready || importNumber.isPending}>
              {importNumber.isPending ? <Spinner /> : <ArrowRight />} {t("importMemory.import")}
            </Button>
          </div>
        </form>
      )}
    </SettingsGroup>
  );
}

function VoiceGroup({ settings, setup }: { settings: Settings; setup: CallSetup | undefined }) {
  const { t } = useTranslation("settings");
  const { patch } = useSettingsPatch();
  const p = settings.phone;
  const voices = setup?.voices ?? [];
  const llms = setup?.llms.length ? setup.llms : [p.llm];
  const voice = voices.find((v) => v.id === p.voiceId);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(false);
  };
  useEffect(() => stop, []);
  useEffect(stop, [p.voiceId]);

  const preview = () => {
    if (playing) return stop();
    if (!voice?.previewUrl) return;
    const a = new Audio(voice.previewUrl);
    audio.current = a;
    a.onended = () => setPlaying(false);
    setPlaying(true);
    void a.play().catch(() => setPlaying(false));
  };

  return (
    <SettingsGroup title={t("calls.voice.title")} icon={<AudioLines />} description={t("calls.voice.description")}>
      <SettingRow label={t("calls.voice.title")} htmlFor="calls-voice" description={voice?.description || t("calls.voice.voiceDescription")}>
        <Select value={p.voiceId || DEFAULT_VOICE} onValueChange={(v) => patch({ phone: { voiceId: v === DEFAULT_VOICE ? "" : v } })}>
          <SelectTrigger id="calls-voice" className="w-56 [&_[data-voice-description]]:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end" className="max-h-80">
            <SelectItem value={DEFAULT_VOICE}>{t("calls.voice.default")}</SelectItem>
            {voices.length > 0 && <SelectSeparator />}
            {voices.map((v) => (
              <SelectItem key={v.id} value={v.id} textValue={v.name}>
                <span className="flex min-w-0 flex-col">
                  <span>{v.name}</span>
                  {v.description && (
                    <span data-voice-description className="truncate text-xs text-muted-foreground">
                      {v.description}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
            {p.voiceId && !voice && <SelectItem value={p.voiceId}>{setup ? t("calls.voice.gone") : p.voiceId}</SelectItem>}
          </SelectContent>
        </Select>
        <Button size="icon" variant="outline" aria-label={playing ? t("calls.voice.stopSample") : t("calls.voice.playSample")} disabled={!voice?.previewUrl} onClick={preview}>
          {playing ? <Square /> : <Play />}
        </Button>
      </SettingRow>
      <SettingRow label={t("calls.voice.model")} htmlFor="calls-llm" description={t("calls.voice.modelDescription")}>
        <Select value={p.llm} onValueChange={(llm) => patch({ phone: { llm } })}>
          <SelectTrigger id="calls-llm" className="w-56 font-mono text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end" className="max-h-80">
            {(llms.includes(p.llm) ? llms : [p.llm, ...llms]).map((m) => (
              <SelectItem key={m} value={m} className="font-mono text-[13px]">
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t("calls.voice.language")} htmlFor="calls-language" description={t("calls.voice.languageDescription")}>
        <Select value={p.language} onValueChange={(language) => patch({ phone: { language } })}>
          <SelectTrigger id="calls-language" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end" className="max-h-80">
            {CALL_LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label} <span className="font-mono text-xs text-muted-foreground">{l.code}</span>
              </SelectItem>
            ))}
            {!CALL_LANGUAGES.some((l) => l.code === p.language) && <SelectItem value={p.language}>{p.language}</SelectItem>}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t("calls.voice.longest")} htmlFor="calls-max" description={t("calls.voice.longestDescription")}>
        <NumberField id="calls-max" value={p.maxMinutes} min={1} max={60} suffix={t("ai.limits.minutes")} className="w-28" onCommit={(v) => v !== null && patch({ phone: { maxMinutes: v } })} />
      </SettingRow>
    </SettingsGroup>
  );
}

function InboundGroup({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const { patch } = useSettingsPatch();
  const p = settings.phone;
  const set = (x: Partial<PhoneSettings>) => patch({ phone: x });
  const agents = (useAllAgents().data ?? []).filter((a) => a.enabled || a.id === p.inboundAgentId);
  const fallback = agents.find((a) => a.isDefault);
  const off = !p.answerInbound;
  return (
    <SettingsGroup title={t("calls.inbound.title")} icon={<PhoneIncoming />} description={t("calls.inbound.description")}>
      <SettingRow label={t("calls.inbound.answer")} htmlFor="calls-inbound">
        <Switch id="calls-inbound" checked={p.answerInbound} onCheckedChange={(answerInbound) => set({ answerInbound })} />
      </SettingRow>
      <SettingRow label={t("calls.inbound.agent")} htmlFor="calls-inbound-agent" disabled={off} description={t("calls.inbound.agentDescription")}>
        <Select value={p.inboundAgentId || DEFAULT_AGENT} disabled={off} onValueChange={(v) => set({ inboundAgentId: v === DEFAULT_AGENT ? "" : v })}>
          <SelectTrigger id="calls-inbound-agent" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value={DEFAULT_AGENT}>
              {fallback ? <AgentAvatar agent={fallback} size="sm" still className="size-4" /> : null}
              {fallback?.name ?? t("calls.inbound.defaultAgent")}
              {fallback && <span className="text-xs text-muted-foreground">· {t("calls.inbound.default")}</span>}
            </SelectItem>
            {agents.some((a) => !a.isDefault) && <SelectSeparator />}
            {agents
              .filter((a) => !a.isDefault)
              .map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <AgentAvatar agent={a} size="sm" still className="size-4" /> {a.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label={t("calls.inbound.greeting")} htmlFor="calls-greeting" disabled={off} description={t("calls.inbound.greetingDescription")} stacked>
        <CommitInput
          id="calls-greeting"
          disabled={off}
          value={p.inboundGreeting}
          placeholder={t("calls.inbound.greetingPlaceholder")}
          onCommit={(v) => set({ inboundGreeting: v.trim() })}
        />
      </SettingRow>
      <SettingRow label={t("calls.inbound.instructions")} htmlFor="calls-instructions" disabled={off} description={t("calls.inbound.instructionsDescription")} stacked>
        <CommitTextarea
          id="calls-instructions"
          disabled={off}
          value={p.inboundInstructions}
          placeholder={t("calls.inbound.instructionsPlaceholder")}
          onCommit={(v) => set({ inboundInstructions: v })}
          className="min-h-28 font-sans text-sm"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
