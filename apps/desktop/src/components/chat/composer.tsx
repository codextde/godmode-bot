import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
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
import { ArrowUp, AudioLines, Loader2, Mic, Paperclip, SquareSlash, Volume2, VolumeX } from "lucide-react";
import { toast } from "sonner";
import type { SlashCommand } from "@godmode/shared";
import { parseSlashCommand } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/common";
import { useDictation, useVoiceSettings } from "@/hooks/use-voice";
import { useVoicePrefs, useVoiceSession, stopSpeaking } from "@/lib/voice";
import { useUi } from "@/stores/ui";
import { loadDraft, saveDraft, useDraft } from "@/lib/drafts";
import { cn } from "@/lib/utils";
import { AttachmentChip, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, readAttachment, type PendingAttachment } from "./attachments";
import { LevelBars } from "./voice-visuals";
import { WorkingTicks } from "@/components/aicss/Motion";
import { SlashHint, SlashMenu, findCommand, rankCommands, slashOptionId, useSlashCommands } from "./slash-commands";

export interface ComposerSubmit {
  content: string;
  attachments: { name: string; mime: string; data: string }[];
  /** The text was (at least partly) dictated */
  voice: boolean;
}

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
  /** Add text below whatever is being written. */
  insert: (text: string) => void;
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
  /** What sending does right now, when it isn't a plain send (e.g. "Send and continue"). */
  sendHint?: string;
  /** Sending isn't possible right now; says why (typing and the draft keep working). */
  blocked?: string;
  /** ↑ in the empty box: edit the newest queued message instead (true = taken). */
  onRecall?: () => boolean;
  /** Rendered in a context tray below the toolbar (e.g. agent picker, folder) */
  leading?: ReactNode;
  /** Rendered before the voice and send buttons (e.g. model picker) */
  trailing?: ReactNode;
  size?: "md" | "lg";
  /** Keep the unsent text and files as a draft under this key */
  draftKey?: string;
  /** Agent whose Claude Code slash commands are offered after typing "/" */
  agentId?: string;
  className?: string;
  ref?: Ref<ComposerHandle>;
}

function joinText(base: string, add: string): string {
  if (!base) return add;
  if (!add) return base;
  return /\s$/.test(base) ? base + add : `${base} ${add}`;
}

const NO_ATTACHMENTS: PendingAttachment[] = [];

export function Composer({
  onSubmit,
  placeholder = "Ask anything, or give your coworker a task…",
  autoFocus,
  busy,
  running,
  sendHint,
  blocked,
  onRecall,
  leading,
  trailing,
  size = "md",
  draftKey,
  agentId,
  className,
  ref,
}: ComposerProps) {
  const navigate = useNavigate();
  const textKey = draftKey ? `chat:${draftKey}` : undefined;
  const filesKey = draftKey ? `chat:${draftKey}:files` : undefined;
  const [text, setText, textDraft] = useDraft(textKey, "");
  const [attachments, setAttachments, filesDraft] = useDraft(filesKey, NO_ATTACHMENTS, { persist: false });
  const [focused, setFocused] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceRef = useRef(false);
  const baseRef = useRef("");
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [menuRoom, setMenuRoom] = useState({ below: false, maxHeight: 352 });
  const [menuActive, setMenuActive] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState<string | null>(null);
  const [menuForced, setMenuForced] = useState(false);
  const commands = useSlashCommands(agentId);

  const voiceSettings = useVoiceSettings();
  const voiceEnabled = voiceSettings?.enabled ?? true;
  const speakReplies = useVoicePrefs((s) => s.speakReplies);
  const setSpeakReplies = useVoicePrefs((s) => s.setSpeakReplies);
  const setVoiceMode = useUi((s) => s.setVoiceMode);
  const armVoice = useVoiceSession((s) => s.arm);

  // Revoke thumbnails on unmount, unless they stay in the draft
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const keepsFiles = !!filesKey;
  useEffect(() => () => {
    if (!keepsFiles) attachmentsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
  }, [keepsFiles]);

  // Autosize
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, size === "lg" ? 320 : 260)}px`;
  }, [text, size]);

  useEffect(() => {
    // preventScroll: focusing must never scroll an ancestor (it used to drag the whole page with it).
    const el = textareaRef.current;
    if (!autoFocus || !el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
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
        el.focus({ preventScroll: true });
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
      focus: () => textareaRef.current?.focus({ preventScroll: true }),
      setText: (t: string) => {
        setText(t);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus({ preventScroll: true });
          el.setSelectionRange(t.length, t.length);
        });
      },
      insert: (t: string) => {
        setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${t}` : t));
        requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
      },
      addFiles: (files: File[]) => void addFiles(files),
    }),
    [addFiles],
  );

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !busy && !blocked;

  // Slash commands: the menu lists matches while only the command name is typed; afterwards a hint shows its arguments.
  const slashToken = /^\/([\w:.-]*)$/.exec(text)?.[1] ?? null;
  const menuQuery = slashToken ?? (menuForced ? "" : null);
  const menuItems = useMemo(
    () => (menuQuery === null ? [] : rankCommands(commands.data ?? [], menuQuery)),
    [menuQuery, commands.data],
  );
  const menuOpen = !!agentId && menuQuery !== null && focused && menuDismissed !== text;
  const menuIndex = Math.min(menuActive, Math.max(0, menuItems.length - 1));
  const typed = parseSlashCommand(text);
  const hint = !menuOpen && slashToken === null && typed ? findCommand(commands.data, typed.name) : undefined;
  useEffect(() => setMenuActive(0), [menuQuery]);
  useLayoutEffect(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!menuOpen || !rect) return;
    const above = rect.top - 60;
    const below = window.innerHeight - rect.bottom - 60;
    const down = above < 240 && below > above;
    setMenuRoom({ below: down, maxHeight: Math.max(144, Math.min(352, down ? below : above)) });
  }, [menuOpen]);

  const pickCommand = (c: SlashCommand) => {
    const next = `/${c.name} ${typed ? typed.args : text.trim()}`;
    setMenuForced(false);
    setText(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(next.length, next.length);
    });
  };

  const toggleCommands = () => {
    if (menuOpen) {
      setMenuDismissed(text);
      setMenuForced(false);
      return;
    }
    if (!text.trim()) setText("/");
    else setMenuForced(true);
    setMenuDismissed(null);
    textareaRef.current?.focus({ preventScroll: true });
  };

  const submit = async () => {
    if (!canSend) return;
    if (dictation.active) dictation.cancel();
    const content = text.trim();
    const sent = attachments;
    const voice = voiceRef.current;
    setMenuForced(false);
    textDraft.discard();
    filesDraft.discard();
    voiceRef.current = false;
    try {
      await onSubmit({ content, attachments: sent.map(({ name, mime, data }) => ({ name, mime, data })), voice });
      sent.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    } catch {
      // Restore so nothing is lost, also when the composer is gone by now; the caller shows the error.
      if (textKey && content && !loadDraft(textKey, "")) saveDraft(textKey, content, "");
      if (filesKey && sent.length && !loadDraft(filesKey, NO_ATTACHMENTS).length) saveDraft(filesKey, sent, NO_ATTACHMENTS, false);
      setText((cur) => cur || content);
      setAttachments((cur) => (cur.length ? cur : sent));
      voiceRef.current = voice;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && !e.nativeEvent.isComposing) {
      const current = menuItems[menuIndex];
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && menuItems.length > 0) {
        e.preventDefault();
        setMenuActive((menuIndex + (e.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length);
        return;
      }
      const enter = e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
      // Tab / Enter complete the name; Enter on an already complete command sends it.
      if (current && (e.key === "Tab" || enter) && !(enter && text.trim() === `/${current.name}`)) {
        e.preventDefault();
        pickCommand(current);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(text);
        setMenuForced(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp" && !text && !attachments.length && onRecall?.()) {
      e.preventDefault();
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
  const working = !!running || !!busy;

  return (
    <div
      ref={rootRef}
      className={cn(
        "@container/composer relative rounded-2xl border bg-card shadow-float transition-[border-color,box-shadow] duration-200",
        focused && "border-foreground/20 ring-4 ring-foreground/[0.035] dark:border-foreground/25 dark:ring-foreground/[0.05]",
        working && "glow-border",
        dragOver && "border-foreground/40 ring-4 ring-foreground/[0.06]",
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
      <AnimatePresence>
        {menuOpen && (
          <SlashMenu
            id={menuId}
            items={menuItems}
            active={menuIndex}
            grouped={!menuQuery}
            loading={commands.isLoading}
            error={commands.error}
            below={menuRoom.below}
            maxHeight={menuRoom.maxHeight}
            onHover={setMenuActive}
            onPick={pickCommand}
          />
        )}
      </AnimatePresence>

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

      <AnimatePresence initial={false}>{hint && <SlashHint key="slash-hint" command={hint} />}</AnimatePresence>

      <label htmlFor={draftKey ? `composer-${draftKey}` : "composer"} className="sr-only">
        Message
      </label>
      <textarea
        id={draftKey ? `composer-${draftKey}` : "composer"}
        ref={textareaRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setMenuForced(false);
        }}
        onKeyDown={onKeyDown}
        aria-autocomplete={agentId ? "list" : undefined}
        aria-controls={menuOpen ? menuId : undefined}
        aria-activedescendant={menuOpen && menuItems[menuIndex] ? slashOptionId(menuId, menuItems[menuIndex].name) : undefined}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={listening ? "Listening…" : placeholder}
        rows={1}
        className={cn(
          "block w-full resize-none bg-transparent px-4 leading-relaxed outline-none placeholder:text-muted-foreground/80",
          size === "lg" ? "min-h-[84px] pt-4 pb-2 text-[15.5px]" : "min-h-[52px] pt-3.5 pb-1.5 text-[15px]",
        )}
      />

      <div className="flex items-center gap-0.5 px-2 pb-2">
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

        {agentId && (
          <ToolbarButton label="Slash commands" onClick={toggleCommands} active={menuOpen} keepFocus className={cn("@max-md/composer:hidden", menuOpen && "bg-accent text-foreground")}>
            <SquareSlash />
          </ToolbarButton>
        )}

        <ToolbarButton
          label={!voiceEnabled ? "Voice is off — enable it in Settings" : dictation.active ? "Stop dictation (Esc)" : "Dictate"}
          onClick={toggleDictation}
          active={dictation.active}
          className={cn(dictation.active && "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive")}
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
          className={cn(speakReplies && "bg-accent text-foreground")}
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
                className="hidden min-w-0 items-center gap-2 pr-1.5 text-xs text-muted-foreground @xl/composer:flex"
              >
                <WorkingTicks count={9} className="text-brand-strong" />
                <span className="truncate">{transcribing ? "Transcribing…" : "Working — new messages are queued"}</span>
              </motion.span>
            )}
            {!running && !transcribing && focused && text.length > 0 && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="hidden shrink-0 items-center gap-1 pr-1 text-[11px] whitespace-nowrap text-muted-foreground @2xl/composer:flex"
              >
                <Kbd>⇧</Kbd>
                <Kbd>↵</Kbd> new line
              </motion.span>
            )}
          </AnimatePresence>

          {trailing}

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
                aria-label={blocked ?? sendHint ?? (running ? "Queue message" : "Send message")}
                className="ml-0.5 size-8 rounded-lg transition-[background-color,transform] active:scale-95 disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-[18px]" strokeWidth={2.4} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {blocked ?? (
                <>
                  {sendHint ?? (running ? "Queue message" : "Send")} <Kbd>↵</Kbd>
                </>
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Context tray: who works on this and with what, kept apart from the input actions so neither row gets crowded. */}
      {leading && (
        <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-b-[calc(var(--radius-2xl)-1px)] border-t border-border/60 bg-muted/40 px-2 py-1.5">
          {leading}
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
  active,
  keepFocus,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  /** Don't take focus from the textarea */
  keepFocus?: boolean;
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
          onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}
          aria-label={label}
          aria-pressed={active}
          className={cn("size-8 rounded-lg text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-[17px]", className)}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
