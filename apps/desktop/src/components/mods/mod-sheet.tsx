import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { MOD_ICONS, modState, type Mod } from "@godmode/shared";
import { CopyButton } from "@/components/chat/copy-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAllAgents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { ModCode, useModDraft } from "./mod-code";
import { ModOptions } from "./mod-options";
import { ModOverview } from "./mod-overview";
import { MOD_ICON_LABEL, ModGlyph, ModIconTile, ModStateBadge, hooksModulePath, modAuthor, type ModTab } from "./mod-parts";
import type { ModActions } from "./use-mod-actions";

const MAX_TITLE = 80;

function isTextField(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** Everything about one mod: what it does and who runs it, its options, its code. */
export function ModSheet({
  mod,
  tab,
  onTabChange,
  onClose,
  onDelete,
  actions,
}: {
  mod: Mod | null;
  tab: ModTab;
  onTabChange: (tab: ModTab) => void;
  onClose: () => void;
  onDelete: (mod: Mod) => void;
  actions: ModActions;
}) {
  // Kept while the sheet closes, so it doesn't empty mid-animation.
  const [last, setLast] = useState(mod);
  if (mod && mod !== last) setLast(mod);
  const shown = mod ?? last;
  const unsaved = useRef(false);
  const [confirming, setConfirming] = useState(false);

  const close = () => {
    if (unsaved.current) setConfirming(true);
    else onClose();
  };

  return (
    <>
      <Sheet open={!!mod} onOpenChange={(open) => !open && close()}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full gap-0 overflow-hidden p-0 outline-none sm:max-w-[920px]"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          // Radix sees Esc before the field does: in a text field it belongs to that field and leaves the sheet open.
          onEscapeKeyDown={(e) => {
            if (isTextField(document.activeElement)) e.preventDefault();
          }}
        >
          {shown && (
            <ModSheetBody
              key={shown.id}
              mod={shown}
              tab={tab}
              onTabChange={onTabChange}
              onClose={close}
              onDelete={() => onDelete(shown)}
              actions={actions}
              onUnsavedChange={(value) => {
                unsaved.current = value;
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>What you changed in “{shown?.title}” since the last save is lost when you close it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                unsaved.current = false;
                onClose();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ModSheetBody({
  mod,
  tab,
  onTabChange,
  onClose,
  onDelete,
  actions,
  onUnsavedChange,
}: {
  mod: Mod;
  tab: ModTab;
  onTabChange: (tab: ModTab) => void;
  onClose: () => void;
  onDelete: () => void;
  actions: ModActions;
  onUnsavedChange: (unsaved: boolean) => void;
}) {
  const { data: agents = [] } = useAllAgents();
  const draft = useModDraft(mod);
  const [optionsDirty, setOptionsDirty] = useState(false);
  const [file, setFile] = useState<{ path: string | null; line: number | null }>(() => ({ path: hooksModulePath(mod.files), line: null }));
  const jump = useMemo(() => (file.line ? { line: file.line } : null), [file]);
  const state = modState(mod);

  const unsaved = draft.isDirty || optionsDirty;
  useEffect(() => {
    onUnsavedChange(unsaved);
    return () => onUnsavedChange(false);
  }, [unsaved, onUnsavedChange]);

  const openFile = (path: string, line: number | null = null) => {
    setFile({ path, line });
    onTabChange("code");
  };

  return (
    <Tabs value={tab} onValueChange={(value) => onTabChange(value as ModTab)} className="@container flex h-full min-h-0 flex-col gap-0">
      <SheetTitle className="sr-only">{mod.title}</SheetTitle>
      <SheetDescription className="sr-only">A mod: what it does and who it runs for, its options and its code.</SheetDescription>

      <header className="shrink-0 border-b bg-paper-2 px-5 pt-5">
        <div className="flex items-start gap-3.5">
          <IconPicker mod={mod} actions={actions} />
          <div className="min-w-0 flex-1">
            <TitleField mod={mod} actions={actions} />
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex h-6 max-w-full min-w-0 items-center rounded-md border bg-card pl-2 font-mono text-[11.5px] text-foreground/85">
                <span className="truncate" title="The plugin's name. It stays as it is: the mod's own code refers to it.">
                  {mod.name}
                </span>
                <CopyButton text={mod.name} label="Copy the plugin name" className="size-[22px]" />
              </span>
              <ModStateBadge state={state} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-1">
            <Switch checked={mod.enabled} onCheckedChange={(on) => actions.toggle(mod, on)} aria-label={`Switch on ${mod.title}`} className="mr-1.5" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="-mr-1.5 text-muted-foreground" aria-label="Close" onClick={onClose}>
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <TabsList variant="line" className="mt-3 -ml-3.5 justify-start">
          <TabsTrigger value="overview" className="flex-none px-2.5">
            Overview
          </TabsTrigger>
          <TabsTrigger value="options" className="flex-none px-2.5">
            Options
            {mod.options.length > 0 && <Count>{mod.options.length}</Count>}
            {optionsDirty && <UnsavedDot />}
          </TabsTrigger>
          <TabsTrigger value="code" className="flex-none px-2.5">
            Code
            <Count>{Object.keys(draft.files).length}</Count>
            {draft.isDirty && <UnsavedDot />}
          </TabsTrigger>
        </TabsList>
      </header>

      <TabsContent value="overview" forceMount className="min-h-0 overflow-y-auto data-[state=inactive]:hidden">
        <ModOverview mod={mod} actions={actions} onOpenCode={() => onTabChange("code")} onOpenFile={openFile} onDelete={onDelete} />
      </TabsContent>
      <TabsContent value="options" forceMount className="min-h-0 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <ModOptions mod={mod} actions={actions} onDirtyChange={setOptionsDirty} />
      </TabsContent>
      <TabsContent value="code" forceMount className="min-h-0 flex-col data-[state=active]:flex data-[state=inactive]:hidden">
        <ModCode
          mod={mod}
          draft={draft}
          actions={actions}
          author={modAuthor(mod, agents)?.name ?? "An agent"}
          activePath={file.path}
          jump={jump}
          onOpenFile={openFile}
        />
      </TabsContent>
    </Tabs>
  );
}

function Count({ children }: { children: number }) {
  return <span className="rounded-[4px] border bg-card px-1 font-mono text-[10px] leading-4 font-normal text-muted-foreground tabular-nums">{children}</span>;
}

function UnsavedDot() {
  return <span role="img" aria-label="Unsaved changes" className="size-1.5 rounded-full bg-foreground/60" />;
}

/** The title, edited in place: it saves when the field is left or Enter is pressed, and Escape takes the edit back. */
function TitleField({ mod, actions }: { mod: Mod; actions: ModActions }) {
  const [text, setText] = useState(mod.title);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(mod.title);
  }, [mod.title]);

  return (
    <input
      aria-label="Title"
      value={text}
      maxLength={MAX_TITLE}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        const next = text.trim();
        if (next && next !== mod.title) actions.update.mutate({ mod, patch: { title: next } });
        setText(next || mod.title);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") setText(mod.title);
      }}
      autoComplete="off"
      spellCheck={false}
      className="-mx-1.5 block h-8 w-[calc(100%+0.75rem)] min-w-0 truncate rounded-md border border-transparent bg-transparent px-1.5 text-lg font-medium tracking-[-0.02em] transition-colors outline-none hover:border-input focus-visible:border-ring focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/50"
    />
  );
}

function IconPicker({ mod, actions }: { mod: Mod; actions: ModActions }) {
  const [open, setOpen] = useState(false);
  const state = modState(mod);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Change the icon"
              className="rounded-lg transition outline-none hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <ModIconTile icon={mod.icon} state={state} raised />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Change the icon</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-auto p-2">
        <div role="group" aria-label="Icon" className="grid grid-cols-4 gap-1">
          {MOD_ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              aria-label={MOD_ICON_LABEL[icon]}
              aria-pressed={icon === mod.icon}
              onClick={() => {
                if (icon !== mod.icon) actions.update.mutate({ mod, patch: { icon } });
                setOpen(false);
              }}
              className={cn(
                "grid size-9 place-items-center rounded-md border transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-[18px]",
                icon === mod.icon ? "border-foreground/30 bg-paper-2 text-foreground" : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <ModGlyph icon={icon} />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
