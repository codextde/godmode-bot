import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, AudioLines, Loader2, Mic, Paperclip, Volume2, VolumeX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/common";
import { useDictation, useVoiceSettings } from "@/hooks/use-voice";
import { useVoicePrefs, useVoiceSession, stopSpeaking } from "@/lib/voice";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { AttachmentChip, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, readAttachment, type PendingAttachment } from "./attachments";
import { LevelBars } from "./voice-visuals";

export interface ComposerSubmit {
  content: string;
  attachments: { name: string; mime: string; data: string }[];
  /** The text was (at least partly) dictated */
  voice: boolean;
}

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

interface ComposerProps {
  onSubmit: (input: ComposerSubmit) => Promise<unknown> | void;
  placeholder?: string;
  autoFocus?: boolean;
  /** A send is in flight */
  busy?: boolean;
  /** The agent is working — new messages get queued */
  running?: boolean;
  /** Rendered at the start of the toolbar (e.g. agent picker) */
  leading?: ReactNode;
  size?: "md" | "lg";
  /** Persist an unsent draft (sessionStorage) under this key */
  draftKey?: string;
  className?: string;
  ref?: Ref<ComposerHandle>;
}

function joinText(base: string, add: string): string {
  if (!base) return add;
  if (!add) return base;
  return /\s$/.test(base) ? base + add : `${base} ${add}`;
}

function loadDraft(key?: string): string {
  if (!key) return "";
  try {
    return sessionStorage.getItem(`gm-draft:${key}`) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(key: string | undefined, text: string) {
  if (!key) return;
  try {
    if (text) sessionStorage.setItem(`gm-draft:${key}`, text);
    else sessionStorage.removeItem(`gm-draft:${key}`);
  } catch {
    /* ignore */
  }
}

export function Composer({
  onSubmit,
  placeholder = "Ask anything, or give your coworker a task…",
  autoFocus,
  busy,
  running,
  leading,
  size = "md",
  draftKey,
  className,
  ref,
}: ComposerProps) {
  const navigate = useNavigate();
  const [text, setText] = useState(() => loadDraft(draftKey));
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [focused, setFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef(false);
  const baseRef = useRef("");

  const voiceSettings = useVoiceSettings();
  const voiceEnabled = voiceSettings?.enabled ?? true;
  const speakReplies = useVoicePrefs((s) => s.speakReplies);
  const setSpeakReplies = useVoicePrefs((s) => s.setSpeakReplies);
  const setVoiceMode = useUi((s) => s.setVoiceMode);
  const armVoice = useVoiceSession((s) => s.arm);

  // Draft persistence
  useEffect(() => {
    setText(loadDraft(draftKey));
  }, [draftKey]);
  useEffect(() => {
    const t = setTimeout(() => saveDraft(draftKey, text), 250);
    return () => clearTimeout(t);
  }, [draftKey, text]);

  // Revoke thumbnails on unmount
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => attachmentsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)), []);

  // Autosize
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, size === "lg" ? 320 : 260)}px`;
  }, [text, size]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const dictation = useDictation({
    mode: "dictation",
    onInterim: (t) => setText(joinText(baseRef.current, t)),
    onFinal: (t) => {
      if (t) {
        setText(joinText(baseRef.current, t));
        voiceRef.current = true;
      }
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
  });

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachmentsRef.current.length;
    if (room <= 0) {
      toast.warning(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const accepted = files.slice(0, room).filter((f) => {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        toast.warning(`${f.name} is larger than 25 MB.`);
        return false;
      }
      return true;
    });
    try {
      const read = await Promise.all(accepted.map(readAttachment));
      setAttachments((prev) => [...prev, ...read]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read the file.");
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      setText: (t: string) => {
        setText(t);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(t.length, t.length);
        });
      },
      addFiles: (files: File[]) => void addFiles(files),
    }),
    [addFiles],
  );

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !busy;

  const submit = async () => {
    if (!canSend) return;
    if (dictation.active) dictation.cancel();
    const content = text.trim();
    const sent = attachments;
    const voice = voiceRef.current;
    setText("");
    setAttachments([]);
    voiceRef.current = false;
    saveDraft(draftKey, "");
    try {
      await onSubmit({ content, attachments: sent.map(({ name, mime, data }) => ({ name, mime, data })), voice });
      sent.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    } catch {
      // Restore so nothing is lost; the caller shows the error.
      setText((cur) => cur || content);
      setAttachments((cur) => (cur.length ? cur : sent));
      voiceRef.current = voice;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape" && dictation.active) {
      e.preventDefault();
      dictation.stop();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length === 0) return;
    const hasText = e.clipboardData.types.includes("text/plain") && e.clipboardData.getData("text/plain").length > 0;
    if (!hasText) e.preventDefault();
    void addFiles(files);
  };

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragOver(false);
    void addFiles(Array.from(e.dataTransfer.files));
  };

  const toggleDictation = () => {
    if (!voiceEnabled) {
      navigate("/settings/voice");
      return;
    }
    if (!dictation.supported) {
      toast.error("Voice input isn't supported in this browser.");
      return;
    }
    if (dictation.active) {
      dictation.stop();
    } else {
      stopSpeaking();
      baseRef.current = text;
      void dictation.start();
    }
  };

  const openVoiceMode = () => {
    if (!voiceEnabled) {
      navigate("/settings/voice");
      return;
    }
    if (dictation.active) dictation.cancel();
    armVoice(true);
    setVoiceMode(true);
  };

  const listening = dictation.state === "listening" || dictation.state === "starting";
  const transcribing = dictation.state === "transcribing";
  const glowing = focused || busy || dictation.active;

  return (
    <div
      className={cn(
        "relative rounded-[26px] glass shadow-xl shadow-black/[0.04] transition-shadow dark:shadow-black/30",
        glowing && "glow-border",
        dragOver && "ring-2 ring-primary/60",
        className,
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <AnimatePresence initial={false}>
        {attachments.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap gap-2 px-4 pt-3.5">
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.id}
                  name={a.name}
                  mime={a.mime}
                  size={a.size}
                  previewUrl={a.previewUrl}
                  onRemove={() => {
                    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
                    setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <label htmlFor={draftKey ? `composer-${draftKey}` : "composer"} className="sr-only">
        Message
      </label>
      <textarea
        id={draftKey ? `composer-${draftKey}` : "composer"}
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={listening ? "Listening…" : placeholder}
        rows={1}
        className={cn(
          "block w-full resize-none bg-transparent px-5 leading-relaxed outline-none placeholder:text-muted-foreground/70",
          size === "lg" ? "min-h-[84px] pt-5 pb-2 text-base" : "min-h-[52px] pt-4 pb-1.5 text-[15px]",
        )}
      />

      <div className="flex items-center gap-1 px-2.5 pb-2.5">
        {leading && <div className="mr-1 flex items-center">{leading}</div>}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <ToolbarButton label="Attach files" onClick={() => fileInputRef.current?.click()}>
          <Paperclip />
        </ToolbarButton>

        <ToolbarButton
          label={!voiceEnabled ? "Voice is off — enable it in Settings" : dictation.active ? "Stop dictation (Esc)" : "Dictate"}
          onClick={toggleDictation}
          active={dictation.active}
          className={cn(dictation.active && "bg-rose-500/15 text-rose-500 hover:bg-rose-500/20 hover:text-rose-500 dark:text-rose-400")}
        >
          {transcribing ? <Loader2 className="animate-spin" /> : listening ? <LevelBars levelRef={dictation.levelRef} /> : <Mic />}
        </ToolbarButton>

        <ToolbarButton
          label={speakReplies ? "Reading replies aloud — click to turn off" : "Read replies aloud"}
          onClick={() => {
            if (speakReplies) stopSpeaking();
            setSpeakReplies(!speakReplies);
          }}
          active={speakReplies}
          className={cn(speakReplies && "text-primary")}
        >
          {speakReplies ? <Volume2 /> : <VolumeX />}
        </ToolbarButton>

        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <AnimatePresence>
            {(running || transcribing) && (
              <motion.span
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 6 }}
                className="hidden truncate pr-1 text-xs text-muted-foreground sm:block"
              >
                {transcribing ? "Transcribing…" : "Working — new messages are queued"}
              </motion.span>
            )}
            {!running && !transcribing && focused && text.length > 0 && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="hidden items-center gap-1 pr-1 text-[11px] text-muted-foreground md:flex"
              >
                <Kbd>⇧</Kbd>
                <Kbd>↵</Kbd> new line
              </motion.span>
            )}
          </AnimatePresence>

          <ToolbarButton label={voiceEnabled ? "Voice mode" : "Voice is off — enable it in Settings"} onClick={openVoiceMode}>
            <AudioLines />
          </ToolbarButton>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={running ? "Queue message" : "Send message"}
                className="size-9 rounded-full bg-gradient-brand text-white shadow-md shadow-glow-a/30 transition hover:opacity-95 hover:shadow-lg disabled:bg-none disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-[18px]" strokeWidth={2.4} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {running ? "Queue message" : "Send"} <Kbd>↵</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
  active,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn("size-9 rounded-full text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-[18px]", className)}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
