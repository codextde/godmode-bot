import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, SmilePlus } from "lucide-react";
import { toast } from "sonner";
import { AGENT_COLORS, MAX_INSTRUCTIONS_LENGTH, type Workspace, type WorkspaceSourceInput } from "@godmode/shared";
import { colorSwatch } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/components/vault/vault-utils";
import { VmSelectField } from "@/components/vms/vm-picker";
import { api } from "@/lib/api";
import { useVmChoices } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { WorkspaceSourcesField, toSourceInput } from "./workspace-sources";
import { WorkspaceTile } from "./workspace-tile";

const EMOJIS = [
  "🚀", "💼", "🏢", "🏠", "🛒", "📈", "💰", "🏦", "💡", "🎯",
  "🧠", "🎨", "✍️", "📣", "💬", "🤝", "🧑‍💻", "🛠️", "⚙️", "🧪",
  "🔬", "📚", "🎓", "🏥", "✈️", "🌍", "🌱", "🍀", "🔥", "⭐",
  "🎮", "🎬", "🎵", "📦", "🧾", "📊", "🗂️", "📝", "🔒", "🐙",
];

const MAX_NAME = 60;
const CONTEXT_EXAMPLE = "We are ACME GmbH. Write to clients in German.\nInvoices go to finance@acme.example.\nNever touch the production database.";

export function WorkspaceDialog({
  open,
  onOpenChange,
  workspace,
  focus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this workspace; omitted = create */
  workspace?: Workspace | null;
  /** Start in the agent context field or at the folders and repositories instead of the name. */
  focus?: "instructions" | "sources";
}) {
  const qc = useQueryClient();
  const setScope = useUi((s) => s.setWorkspace);
  const editing = !!workspace;
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🚀");
  const [color, setColor] = useState<string>("violet");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [vmId, setVmId] = useState<string | null>(null);
  const [sources, setSources] = useState<WorkspaceSourceInput[]>([]);
  const sourcesRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const vmChoices = useVmChoices();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customEmoji, setCustomEmoji] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(workspace?.name ?? "");
    setIcon(workspace?.icon || EMOJIS[Math.floor(Math.random() * 10)]);
    setColor(workspace?.color || AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)]);
    setDescription(workspace?.description ?? "");
    setInstructions(workspace?.instructions ?? "");
    setVmId(workspace?.vmId ?? null);
    setSources(workspace?.sources.map(toSourceInput) ?? []);
    setCustomEmoji("");
  }, [open, workspace]);

  useEffect(() => {
    if (!open || focus !== "sources") return;
    const t = setTimeout(() => {
      const list = scrollRef.current;
      const section = sourcesRef.current;
      if (!list || !section) return;
      const top = section.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 16;
      list.scrollTo({ top, behavior: "smooth" });
    }, 120);
    return () => clearTimeout(t);
  }, [open, focus]);

  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        icon,
        color,
        description: description.trim(),
        instructions: instructions.trim(),
        sources,
        // Only when the VM control is shown: otherwise leave the assignment as it is.
        ...(vmChoices.available ? { vmId } : {}),
      };
      return workspace ? api.workspaces.update(workspace.id, input) : api.workspaces.create(input);
    },
    onSuccess: (ws) => {
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      if (editing) toast.success("Workspace updated");
      else
        toast.success(`${ws.icon} ${ws.name} created`, {
          description: "Add agents, logins and integrations to it.",
          action: { label: "Switch to it", onClick: () => setScope(ws.id) },
        });
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, editing ? "Could not update workspace" : "Could not create workspace", qc),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !save.isPending) save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        <form onSubmit={submit} className="min-w-0">
          <div className="relative overflow-hidden border-b bg-paper-2 px-6 pt-6 pb-5">
            <DialogHeader className="relative">
              <DialogTitle>{editing ? "Edit workspace" : "New workspace"}</DialogTitle>
              <DialogDescription>
                A separate space for a client, project or area of your life — with its own agents, logins, 2FA codes and integrations.
              </DialogDescription>
            </DialogHeader>
            <div className="relative mt-5 flex items-center gap-4">
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <button type="button" aria-label="Choose icon" className="group relative rounded-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    <WorkspaceTile icon={icon} color={color} size="xl" />
                    <span className="absolute -right-1 -bottom-1 grid size-6 place-items-center rounded-md border bg-card text-muted-foreground shadow-card transition group-hover:text-foreground">
                      <SmilePlus className="size-3.5" />
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[20.5rem] rounded-xl p-3">
                  <div className="grid grid-cols-8 gap-1" role="listbox" aria-label="Icons">
                    {EMOJIS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        role="option"
                        aria-selected={icon === e}
                        onClick={() => {
                          setIcon(e);
                          setPickerOpen(false);
                        }}
                        className={cn(
                          "grid size-9 place-items-center rounded-lg text-xl transition hover:bg-accent",
                          icon === e && "bg-accent ring-1 ring-foreground/20",
                        )}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex gap-2 border-t pt-3">
                    <Input
                      aria-label="Custom emoji"
                      placeholder="Or paste any emoji…"
                      value={customEmoji}
                      maxLength={16}
                      onChange={(e) => setCustomEmoji(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && customEmoji.trim()) {
                          e.preventDefault();
                          setIcon(customEmoji.trim());
                          setPickerOpen(false);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      aria-label="Use emoji"
                      disabled={!customEmoji.trim()}
                      onClick={() => {
                        setIcon(customEmoji.trim());
                        setPickerOpen(false);
                      }}
                    >
                      <Check />
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              <div className="min-w-0 flex-1">
                <p className="truncate text-lg font-medium tracking-[-0.02em]">{name.trim() || "Untitled workspace"}</p>
                <p className="line-clamp-1 text-sm text-muted-foreground">{description.trim() || "Click the icon to change it"}</p>
              </div>
            </div>
          </div>

          <div ref={scrollRef} className="max-h-[min(36rem,calc(100dvh-18rem))] space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="ws-name">Name</Label>
              <Input
                id="ws-name"
                autoFocus={!focus}
                required
                maxLength={MAX_NAME}
                placeholder="e.g. ACME Corp, Side project, Household"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label id="ws-color-label">Color</Label>
              <div role="radiogroup" aria-labelledby="ws-color-label" className="flex flex-wrap gap-2">
                {AGENT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={color === c}
                    aria-label={c}
                    onClick={() => setColor(c)}
                    className={cn(
                      "grid size-7 place-items-center rounded-md ring-offset-2 ring-offset-background transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      colorSwatch(c),
                      color === c && "ring-2 ring-foreground/70",
                    )}
                  >
                    {color === c && <Check className="size-3.5 text-white" />}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ws-desc">
                Description <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="ws-desc"
                rows={3}
                placeholder="What happens in this workspace? Agents see this as context."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="space-y-0.5">
                <Label htmlFor="ws-instructions">
                  Agent context <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <p className="text-xs text-muted-foreground">Given to every agent in this workspace on every run.</p>
              </div>
              <Textarea
                id="ws-instructions"
                autoFocus={focus === "instructions"}
                rows={5}
                maxLength={MAX_INSTRUCTIONS_LENGTH}
                placeholder={CONTEXT_EXAMPLE}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                className="max-h-72 min-h-28 resize-y leading-relaxed"
              />
            </div>
            <div ref={sourcesRef} className="space-y-2">
              <div className="space-y-0.5">
                <Label>
                  Folders &amp; repositories <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <p className="text-xs text-muted-foreground">Every agent in this workspace can read and edit these. Repositories are cloned for them.</p>
              </div>
              <WorkspaceSourcesField workspaceId={workspace?.id ?? null} value={sources} onChange={setSources} />
            </div>
            {vmChoices.available && (
              <VmSelectField
                id="ws-vm"
                label={
                  <>
                    Virtual machine <span className="font-normal text-muted-foreground">(optional)</span>
                  </>
                }
                value={vmId}
                onChange={setVmId}
                noneLabel="None — agents work on this Mac"
                hint="The workspace's agents work in this macOS VM, unless an agent or a chat has its own."
              />
            )}
          </div>

          <DialogFooter className="border-t bg-paper-2 px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending && <Spinner />}
              {editing ? "Save changes" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
