import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiRequestError, errorMessage, fetchBlob } from "@/lib/api";

GlobalWorkerOptions.workerPort ??= new PdfWorker();

export function usePdf(url: string) {
  const file = useQuery({
    queryKey: ["core-pdf", url],
    queryFn: async () => new Uint8Array(await (await fetchBlob(url)).arrayBuffer()),
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!file.data) return;
    const task = getDocument({ data: file.data.slice() });
    let done = false;
    task.promise.then(
      (d) => {
        if (!done) setDoc(d);
      },
      (err) => {
        if (!done) setError(err);
      },
    );
    return () => {
      done = true;
      setDoc(null);
      setError(null);
      void task.destroy();
    };
  }, [file.data]);
  return { doc, data: file.data ?? null, error: file.error ?? error, refetch: file.refetch, fetching: file.isFetching };
}

export function PdfPages({ doc, error, name, zoom }: { doc: PDFDocumentProxy | null; error: unknown; name: string; zoom: number }) {
  const { t } = useTranslation("chat");
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-auto bg-muted/40 px-4 py-4">
      {error ? (
        <p className="flex gap-2 font-sans text-sm text-muted-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error instanceof ApiRequestError && error.status === 404 ? t("pdf.gone", { name }) : t("pdf.failed", { name, message: errorMessage(error) })}
        </p>
      ) : doc && width > 0 ? (
        <div className="mx-auto flex w-max min-w-full flex-col items-center gap-3">
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i} doc={doc} number={i + 1} width={Math.max(120, (width - 32) * zoom)} label={t("pdf.page", { page: i + 1, count: doc.numPages })} />
          ))}
        </div>
      ) : (
        <div className="mx-auto flex max-w-full flex-col items-center gap-3">
          <Skeleton className="aspect-[1/1.414] w-full max-w-[640px]" />
        </div>
      )}
    </div>
  );
}

function PdfPage({ doc, number, width, label }: { doc: PDFDocumentProxy; number: number; width: number; label: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [seen, setSeen] = useState(number <= 2);
  useEffect(() => {
    let live = true;
    void doc.getPage(number).then((p) => live && setPage(p));
    return () => {
      live = false;
    };
  }, [doc, number]);
  useEffect(() => {
    const el = holder.current;
    if (!el || seen) return;
    const observer = new IntersectionObserver(([entry]) => entry!.isIntersecting && setSeen(true), { rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);
  const base = page?.getViewport({ scale: 1 });
  const scale = base ? width / base.width : 1;
  const height = base ? Math.round(base.height * scale) : Math.round(width * 1.414);
  useEffect(() => {
    if (!page || !seen || !canvas.current) return;
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * ratio });
    const el = canvas.current;
    el.width = Math.floor(viewport.width);
    el.height = Math.floor(viewport.height);
    const task = page.render({ canvas: el, viewport });
    task.promise.catch(() => {});
    return () => task.cancel();
  }, [page, seen, scale]);
  return (
    <div ref={holder} role="img" aria-label={label} className="relative shrink-0 overflow-hidden rounded-sm bg-white shadow-card" style={{ width: Math.round(width), height }}>
      <canvas ref={canvas} className="block size-full" />
    </div>
  );
}
