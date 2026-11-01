import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Download, FileText, FolderOpen, Minus, PanelRightClose, Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { isMac, saveBlob } from "@/lib/desktop";
import { PANEL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PdfPages, usePdf } from "./pdf-pages";

export interface PdfSource {
  url: string;
  name: string;
  path: string | null;
  local: boolean;
}

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

function PdfView({ source, chrome }: { source: PdfSource; chrome: (header: ReactNode) => ReactNode }) {
  const { t } = useTranslation("chat");
  const pdf = usePdf(source.url);
  const [zoom, setZoom] = useState(1);
  const at = ZOOMS.indexOf(zoom);
  const save = async () => {
    if (!pdf.data) return;
    try {
      await saveBlob(new Blob([pdf.data.slice()], { type: "application/pdf" }), source.name);
    } catch (err) {
      toast.error(t("files.downloadError", { name: source.name }), { description: errorMessage(err) });
    }
  };
  const reveal = () =>
    void api.files.reveal(source.path!).catch((err) => {
      const gone = err instanceof ApiRequestError && err.status === 404;
      toast.error(gone ? t("files.gone", { name: source.name }) : isMac ? t("files.finderError") : t("files.fileManagerError"), gone ? undefined : { description: errorMessage(err) });
    });
  const header = (
    <>
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{source.name}</p>
        <p className="truncate text-[11.5px] text-muted-foreground tabular-nums" title={source.path ?? undefined}>
          {pdf.doc ? t("pdf.pages", { count: pdf.doc.numPages }) : "PDF"} · {Math.round(zoom * 100)}%
        </p>
      </div>
      <IconAction label={t("pdf.zoomOut")} onClick={() => setZoom(ZOOMS[at - 1]!)} disabled={at <= 0}>
        <Minus />
      </IconAction>
      <IconAction label={t("pdf.zoomIn")} onClick={() => setZoom(ZOOMS[at + 1]!)} disabled={at >= ZOOMS.length - 1}>
        <Plus />
      </IconAction>
      <IconAction label={t("filePanel.reload")} onClick={() => void pdf.refetch()} disabled={pdf.fetching}>
        <RefreshCw className={cn(pdf.fetching && "animate-spin [animation-duration:1.6s]")} />
      </IconAction>
      <IconAction label={t("files.save")} onClick={() => void save()} disabled={!pdf.data}>
        <Download />
      </IconAction>
      {source.local && source.path && (
        <IconAction label={isMac ? t("files.showInFinder") : t("files.showInFolder")} onClick={reveal}>
          <FolderOpen />
        </IconAction>
      )}
    </>
  );
  return (
    <>
      {chrome(header)}
      <PdfPages doc={pdf.doc} error={pdf.error} name={source.name} zoom={zoom} />
    </>
  );
}

export default function PdfPanel({ source, onHide }: { source: PdfSource; onHide: () => void }) {
  const { t } = useTranslation("chat");
  const width = "min(50vw, 760px)";
  return (
    <motion.aside
      aria-label={source.name}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={PANEL}
      className="h-full shrink-0 overflow-hidden border-l bg-paper-2"
    >
      <div className="flex h-full flex-col" style={{ width }}>
        <PdfView
          source={source}
          chrome={(header) => (
            <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
              {header}
              <IconAction label={t("filePanel.close")} onClick={onHide}>
                <PanelRightClose />
              </IconAction>
            </header>
          )}
        />
      </div>
    </motion.aside>
  );
}

export function PdfDialog({ source, open, onOpenChange }: { source: PdfSource; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("chat");
  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined} showCloseButton={false} className="flex h-[88vh] w-[min(92vw,900px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <DialogTitle className="sr-only">{source.name}</DialogTitle>
          {open && (
            <PdfView
              source={source}
              chrome={(header) => (
                <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
                  {header}
                  <IconAction label={t("filePanel.close")} onClick={() => onOpenChange(false)}>
                    <X />
                  </IconAction>
                </header>
              )}
            />
          )}
        </DialogContent>
      </Dialog>
    </span>
  );
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
