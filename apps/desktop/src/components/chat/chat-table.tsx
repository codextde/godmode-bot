import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Copy, FileText, Maximize2, Table2, X, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "./copy-button";

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** The cells of a rendered table, row by row, as the reader sees them. */
function cellsOf(table: HTMLTableElement): string[][] {
  return Array.from(table.rows, (row) => Array.from(row.cells, (cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()));
}

/** GFM: the first row is the header, the columns keep their alignment. */
function markdownOf(table: HTMLTableElement): string {
  const [head = [], ...body] = cellsOf(table);
  const width = Math.max(head.length, ...body.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => (cells[i] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
  const aligns = Array.from({ length: width }, (_, i) => {
    const align = table.rows[0]?.cells[i]?.style.textAlign;
    return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
  });
  return [line(head), `| ${aligns.join(" | ")} |`, ...body.map(line)].join("\n");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A real table where the paste takes HTML (Sheets, Excel, Slack, Notion, Mail), tab-separated text everywhere else. */
async function copyTable(table: HTMLTableElement): Promise<boolean> {
  const [head = [], ...body] = cellsOf(table);
  const tsv = [head, ...body].map((r) => r.join("\t")).join("\n");
  const row = (cells: string[], tag: "th" | "td") => `<tr>${cells.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("")}</tr>`;
  const html = `<meta charset="utf-8"><table><thead>${row(head, "th")}</thead><tbody>${body.map((r) => row(r, "td")).join("")}</tbody></table>`;
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([tsv], { type: "text/plain" }) }),
      ]);
      return true;
    } catch {
      /* plain text below */
    }
  }
  return copyText(tsv);
}

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick} className="text-muted-foreground hover:text-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CopyMenu({ tableRef }: { tableRef: RefObject<HTMLTableElement | null> }) {
  // Clipboard writes must start inside the click in WebKit (the desktop app): nothing is awaited before them.
  const copy = async (markdown: boolean) => {
    const table = tableRef.current;
    if (!table) return;
    if (await (markdown ? copyText(markdownOf(table)) : copyTable(table))) toast.success(markdown ? "Copied as Markdown" : "Table copied");
    else toast.error("Couldn't copy the table");
  };
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy table" className="text-muted-foreground hover:text-foreground">
              <Copy />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Copy table</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={() => void copy(false)}>
          <Table2 /> Copy table
          <span className="ml-auto text-xs text-muted-foreground">Slack, Sheets</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copy(true)}>
          <FileText /> Copy as Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same table full screen, scrollable both ways, with zoom. */
function TableDialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [zoom, setZoom] = useState(1);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1600px)]"
      >
        <header className="flex items-center gap-2 border-b py-2 pr-2 pl-5">
          <DialogTitle className="text-sm font-medium">Table</DialogTitle>
          <div className="ml-auto flex items-center gap-0.5">
            <ToolButton label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom((z) => ZOOMS.findLast((s) => s < z) ?? z)}>
              <ZoomOut />
            </ToolButton>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="xs" aria-label={`Reset zoom (${Math.round(zoom * 100)}%)`} onClick={() => setZoom(1)} className="w-12 text-muted-foreground tabular-nums hover:text-foreground">
                  {Math.round(zoom * 100)}%
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset to 100%</TooltipContent>
            </Tooltip>
            <ToolButton label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom((z) => ZOOMS.find((s) => s > z) ?? z)}>
              <ZoomIn />
            </ToolButton>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <CopyMenu tableRef={tableRef} />
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Close" className="text-muted-foreground hover:text-foreground">
                <X />
              </Button>
            </DialogClose>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <div className="prose-chat" style={{ zoom }}>
            <div className="w-fit min-w-full overflow-hidden rounded-lg border bg-card shadow-card">
              <table ref={tableRef}>{children}</table>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A table in chat: on hover, copy it (for Slack and spreadsheets, or as Markdown) or open it full screen. */
export function ChatTable({ children }: { children?: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="group/table relative">
      <div className="overflow-x-auto rounded-lg border bg-card shadow-card">
        <table ref={tableRef}>{children}</table>
      </div>
      {/* The menu and dialog are portals, yet React bubbles their clicks up to a description that opens its editor on click. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute -top-3.5 right-2 z-10 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 opacity-0 shadow-card transition pointer-events-none group-focus-within/table:pointer-events-auto group-focus-within/table:opacity-100 group-hover/table:pointer-events-auto group-hover/table:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
      >
        <CopyMenu tableRef={tableRef} />
        <ToolButton label="Full screen" onClick={() => setOpen(true)}>
          <Maximize2 />
        </ToolButton>
        <TableDialog open={open} onOpenChange={setOpen}>
          {children}
        </TableDialog>
      </div>
    </div>
  );
}
