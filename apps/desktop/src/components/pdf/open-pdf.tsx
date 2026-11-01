import { lazy, Suspense, useCallback, useContext, useState } from "react";
import { SidePanelScope, useChatSidePanel } from "@/components/side-panel/store";
import type { PdfSource } from "./pdf-viewer";

export type { PdfSource };

const PdfDialog = lazy(() => import("./pdf-viewer").then((m) => ({ default: m.PdfDialog })));

export function useOpenPdf() {
  const side = useContext(SidePanelScope);
  const showSide = useChatSidePanel((s) => s.show);
  const [shown, setShown] = useState<PdfSource | null>(null);
  const [open, setOpen] = useState(false);
  const openPdf = useCallback(
    (source: PdfSource) => {
      if (side) return showSide(side.conversationId, { kind: "pdf", source });
      setShown(source);
      setOpen(true);
    },
    [side, showSide],
  );
  const current = side?.current?.kind === "pdf" ? side.current.source.url : null;
  const dialog = shown ? (
    <Suspense fallback={null}>
      <PdfDialog source={shown} open={open} onOpenChange={setOpen} />
    </Suspense>
  ) : null;
  return { openPdf, current, dialog };
}
