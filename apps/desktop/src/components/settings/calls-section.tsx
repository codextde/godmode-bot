import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, AudioLines, CircleCheck, Hash, PhoneCall, PhoneIncoming, Play, Plus, RefreshCw, Square, UserRound } from "lucide-react";
import { toast } from "sonner";
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
import { Callout, CommitInput, CommitTextarea, NumberField, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

const FIRST_NUMBER = "__first";
const DEFAULT_VOICE = "__default";
const DEFAULT_AGENT = "__default";

const KEY_SOURCE: Record<NonNullable<CallSetup["keySource"]>, string> = {
  vault: "Your ElevenLabs key from the vault",
  api_tool: "The ElevenLabs key of an API tool",
};

export function useCallSetup() {
  return useQuery({ queryKey: qk.callSetup, queryFn: api.calls.setup, staleTime: 60_000, retry: 1 });
}

export function CallsSection({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const qc = useQueryClient();
  const p = settings.phone;
  const set = (x: Partial<PhoneSettings>) => patch({ phone: x });
  const setup = useCallSetup();
  const s = setup.data;

  const test = useMutation({
    mutationFn: api.calls.test,
    onSuccess: () => {
      toast.success("Calling you now", { description: "Pick up to hear how your agents sound on the phone." });
      void qc.invalidateQueries({ queryKey: qk.calls });
    },
    onError: (e) => toastApiError(e, "Couldn't call you", qc),
  });

  const saveOwnerNumber = (raw: string) => {
    if (!raw.trim()) {
      if (p.ownerNumber) set({ ownerNumber: "" });
      return;
    }
    const number = toE164(raw);
    if (!number) {
      toast.error("That isn't a phone number Godmode can call", { description: "Write it with the country code, e.g. +49 151 12345678." });
      return;
    }
    if (number !== p.ownerNumber) set({ ownerNumber: number });
  };

  const saveQuiet = (key: "quietFrom" | "quietTo", v: string) => {
    if (v === "" || isClockTime(v)) set({ [key]: v });
  };

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Phone calls"
        description="Let agents phone people for you, call you when something can't wait, and answer calls to your number. The voice runs on ElevenLabs; every finished call continues the chat that placed it."
      />

      <SetupStatus setup={setup} />

      <SettingsGroup title="Phone calls" icon={<PhoneCall />}>
        <SettingRow
          label="Let agents make and take calls"
          htmlFor="calls-enabled"
          description="Agents get a tool to place calls, and Godmode picks up incoming ones. Turned off, nothing is dialled and calls to your number aren't answered by Godmode."
        >
          <Switch id="calls-enabled" checked={p.enabled} onCheckedChange={(enabled) => set({ enabled })} />
        </SettingRow>
      </SettingsGroup>

      <NumberGroup settings={settings} setup={s} loading={setup.isPending} />

      <SettingsGroup
        title="Calls to you"
        icon={<UserRound />}
        description="For questions that can't wait and news you should hear right away. Everything else stays in the app."
        actions={
          <Button size="sm" variant="outline" disabled={!p.enabled || !p.ownerNumber || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Spinner /> : <PhoneCall />} Test call
          </Button>
        }
      >
        <SettingRow label="Your number" htmlFor="calls-owner" description="With the country code. Leave it empty and agents never call you.">
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
          label="Agents may call you"
          htmlFor="calls-owner-on"
          disabled={!p.ownerNumber}
          description="For urgent questions and news. Your answer on the call goes straight back to the agent that asked."
        >
          <Switch id="calls-owner-on" checked={p.callOwner} disabled={!p.ownerNumber} onCheckedChange={(callOwner) => set({ callOwner })} />
        </SettingRow>
        <SettingRow
          label="Quiet hours"
          disabled={!p.ownerNumber || !p.callOwner}
          description={
            p.quietFrom && p.quietTo
              ? `No calls to you from ${p.quietFrom} to ${p.quietTo}; questions wait in the app until then.`
              : "Agents may call you at any time of day."
          }
        >
          <div className="flex items-center gap-2">
            <CommitInput
              type="time"
              aria-label="Quiet from"
              className="w-28 tabular-nums"
              value={p.quietFrom}
              onCommit={(v) => saveQuiet("quietFrom", v)}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <CommitInput type="time" aria-label="Quiet until" className="w-28 tabular-nums" value={p.quietTo} onCommit={(v) => saveQuiet("quietTo", v)} />
            {(p.quietFrom || p.quietTo) && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => set({ quietFrom: "", quietTo: "" })}>
                Clear
              </Button>
            )}
          </div>
        </SettingRow>
      </SettingsGroup>

      <VoiceGroup settings={settings} setup={s} />

      <InboundGroup settings={settings} />
    </div>
  );
}

function SetupStatus({ setup }: { setup: ReturnType<typeof useCallSetup> }) {
  const s = setup.data;
  const retry = (
    <Button size="xs" variant="ghost" className="-ml-2 text-foreground" disabled={setup.isFetching} onClick={() => setup.refetch()}>
      {setup.isFetching ? <Spinner /> : <RefreshCw />} Check again
    </Button>
  );
  if (setup.isPending) return <Callout tone="muted" icon={<Spinner className="text-muted-foreground" />} title="Checking your ElevenLabs account…" />;
  if (setup.isError || !s)
    return (
      <Callout tone="warning" title="Couldn't reach ElevenLabs">
        <p>{errorMessage(setup.error)}</p>
        {retry}
      </Callout>
    );
  const source = s.keySource ? KEY_SOURCE[s.keySource] : null;
  if (s.ready)
    return (
      <Callout tone="info" icon={<CircleCheck className="text-emerald-600 dark:text-emerald-400" />} title="Ready to call">
        <p>
          {source} · {s.numbers.length} {s.numbers.length === 1 ? "number" : "numbers"} · {s.voices.length} voices
        </p>
        {retry}
      </Callout>
    );
  return (
    <Callout tone="warning" title="Calls aren't ready yet">
      <ul className="list-disc space-y-0.5 pl-4">
        {s.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
      <p className="mt-1.5">
        {source ? (
          `Using: ${source.charAt(0).toLowerCase()}${source.slice(1)}.`
        ) : (
          <>
            No ElevenLabs key yet. Add one under{" "}
            <Link to="/settings/api-keys" className="font-medium text-primary underline-offset-2 hover:underline">
              Integrations → API keys
            </Link>
            .
          </>
        )}
      </p>
      {retry}
    </Callout>
  );
}

function NumberGroup({ settings, setup, loading }: { settings: Settings; setup: CallSetup | undefined; loading: boolean }) {
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
      toast.success("Number imported", { description: `${number} can now place and take calls.` });
      setForm({ number: "", label: "", sid: "", token: "" });
      setAdding(false);
    },
    onError: (e) => toastApiError(e, "Couldn't import the number", qc),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !importNumber.isPending) importNumber.mutate();
  };

  const first = numbers[0];
  return (
    <SettingsGroup
      title="Number"
      icon={<Hash />}
      description="The number your agents call from, and the one people call to reach Godmode. Calls go out from a number in the callee's country when you have one."
      actions={
        !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus /> Import a Twilio number
          </Button>
        )
      }
    >
      <SettingRow
        label="Calls go out from"
        htmlFor="calls-number"
        description={loading ? "Loading the numbers in your ElevenLabs account…" : numbers.length ? undefined : "No numbers in your ElevenLabs account yet. Import one from Twilio here."}
      >
        <Select value={p.numberId || FIRST_NUMBER} onValueChange={(v) => patch({ phone: { numberId: v === FIRST_NUMBER ? "" : v } })} disabled={!numbers.length}>
          <SelectTrigger id="calls-number" className="w-64">
            <SelectValue placeholder="No number yet" />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value={FIRST_NUMBER}>
              <span className="font-mono text-[13px]">{first?.number ?? "First number"}</span>
              <span className="text-xs text-muted-foreground">· first in the account</span>
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
                <span className="text-muted-foreground">A number that's gone</span>
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </SettingRow>

      {adding && (
        <form onSubmit={submit} className="space-y-3 py-4">
          <div className="grid gap-3 @xl:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="import-number">Number</Label>
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
              <Label htmlFor="import-label">Label</Label>
              <Input id="import-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Office line" autoComplete="off" />
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
              <PasswordInput id="import-token" groupClassName="h-9" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="From the Twilio console" />
            </div>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The token goes to ElevenLabs to connect the number; Godmode doesn't keep it. SIP trunk numbers work too: add them in the ElevenLabs dashboard under Phone
            numbers and they show up here.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!ready || importNumber.isPending}>
              {importNumber.isPending ? <Spinner /> : <ArrowRight />} Import
            </Button>
          </div>
        </form>
      )}
    </SettingsGroup>
  );
}

function VoiceGroup({ settings, setup }: { settings: Settings; setup: CallSetup | undefined }) {
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
    <SettingsGroup title="Voice" icon={<AudioLines />} description="How Godmode sounds and thinks on the phone.">
      <SettingRow label="Voice" htmlFor="calls-voice" description={voice?.description || "The ElevenLabs voice your agents speak with."}>
        <Select value={p.voiceId || DEFAULT_VOICE} onValueChange={(v) => patch({ phone: { voiceId: v === DEFAULT_VOICE ? "" : v } })}>
          <SelectTrigger id="calls-voice" className="w-56 [&_[data-voice-description]]:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end" className="max-h-80">
            <SelectItem value={DEFAULT_VOICE}>ElevenLabs default</SelectItem>
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
            {p.voiceId && !voice && <SelectItem value={p.voiceId}>{setup ? "A voice that's gone" : p.voiceId}</SelectItem>}
          </SelectContent>
        </Select>
        <Button size="icon" variant="outline" aria-label={playing ? "Stop the sample" : "Play a sample"} disabled={!voice?.previewUrl} onClick={preview}>
          {playing ? <Square /> : <Play />}
        </Button>
      </SettingRow>
      <SettingRow label="Model" htmlFor="calls-llm" description="Talks on the call. Faster models keep the pauses short.">
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
      <SettingRow label="Language" htmlFor="calls-language" description="What calls start in when the agent doesn't say. The voice follows the other side if they switch.">
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
      <SettingRow label="Longest call" htmlFor="calls-max" description="Godmode hangs up after this, whatever the state of the call.">
        <NumberField id="calls-max" value={p.maxMinutes} min={1} max={60} suffix="min" className="w-28" onCommit={(v) => v !== null && patch({ phone: { maxMinutes: v } })} />
      </SettingRow>
    </SettingsGroup>
  );
}

function InboundGroup({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const p = settings.phone;
  const set = (x: Partial<PhoneSettings>) => patch({ phone: x });
  const agents = (useAllAgents().data ?? []).filter((a) => a.enabled || a.id === p.inboundAgentId);
  const fallback = agents.find((a) => a.isDefault);
  const off = !p.answerInbound;
  return (
    <SettingsGroup title="Incoming calls" icon={<PhoneIncoming />} description="When someone calls your number, Godmode's voice picks up. Each finished call becomes a chat for the agent below.">
      <SettingRow label="Answer incoming calls" htmlFor="calls-inbound">
        <Switch id="calls-inbound" checked={p.answerInbound} onCheckedChange={(answerInbound) => set({ answerInbound })} />
      </SettingRow>
      <SettingRow label="Agent" htmlFor="calls-inbound-agent" disabled={off} description="Gets the transcript and the caller's request afterwards, and follows up.">
        <Select value={p.inboundAgentId || DEFAULT_AGENT} disabled={off} onValueChange={(v) => set({ inboundAgentId: v === DEFAULT_AGENT ? "" : v })}>
          <SelectTrigger id="calls-inbound-agent" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value={DEFAULT_AGENT}>
              {fallback ? <AgentAvatar agent={fallback} size="sm" still className="size-4" /> : null}
              {fallback?.name ?? "Default agent"}
              {fallback && <span className="text-xs text-muted-foreground">· default</span>}
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
      <SettingRow label="Greeting" htmlFor="calls-greeting" disabled={off} description="The first thing callers hear." stacked>
        <CommitInput
          id="calls-greeting"
          disabled={off}
          value={p.inboundGreeting}
          placeholder="Hi, you've reached Studio Berg. How can I help?"
          onCommit={(v) => set({ inboundGreeting: v.trim() })}
        />
      </SettingRow>
      <SettingRow label="Instructions" htmlFor="calls-instructions" disabled={off} description="Who answers and how: your business, what to ask callers, what to promise." stacked>
        <CommitTextarea
          id="calls-instructions"
          disabled={off}
          value={p.inboundInstructions}
          placeholder="You answer for Studio Berg, a hair salon in Hamburg. Take the caller's name, what they need and when they're free. Don't confirm appointments; say we'll call back today."
          onCommit={(v) => set({ inboundInstructions: v })}
          className="min-h-28 font-sans text-sm"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
