import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, CircleCheck, ClipboardPaste, ImagePlus, QrCode, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { decodeQrCodes, isOtpUri } from "@/lib/qr";
import { modKey } from "@/lib/desktop";
import { cn } from "@/lib/utils";

export interface QrImage {
  id: string;
  name: string;
  /** Object URL for the thumbnail */
  url: string;
  status: "decoding" | "done" | "error";
  /** Every QR payload found in the image */
  found: string[];
  error?: string;
}

let seq = 0;

/** Holds dropped/pasted screenshots and decodes each one locally. */
export function useQrImages() {
  const [items, setItems] = useState<QrImage[]>([]);
  const urls = useRef(new Set<string>());

  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current.clear();
    },
    [],
  );

  const addFiles = useCallback((files: File[] | FileList) => {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i.test(f.name));
    for (const file of images) {
      const id = `qr-${++seq}`;
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      setItems((prev) => [...prev, { id, name: file.name || "Pasted image", url, status: "decoding", found: [] }]);
      decodeQrCodes(file)
        .then((found) => setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: "done", found } : it))))
        .catch((e: unknown) =>
          setItems((prev) =>
            prev.map((it) => (it.id === id ? { ...it, status: "error", error: e instanceof Error ? e.message : "Could not read image" } : it)),
          ),
        );
    }
    return images.length;
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const it = prev.find((p) => p.id === id);
      if (it) {
        URL.revokeObjectURL(it.url);
        urls.current.delete(it.url);
      }
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current.clear();
    setItems([]);
  }, []);

  return { items, addFiles, remove, clear };
}

export function QrDropZone({ items, onFiles, onRemove }: { items: QrImage[]; onFiles: (files: FileList | File[]) => void; onRemove: (id: string) => void }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
  };

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Add QR code screenshots"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          "group relative flex cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-dashed px-6 py-8 text-center transition-colors outline-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          dragging ? "border-foreground/40 bg-accent" : "border-foreground/15 bg-paper-2 hover:border-foreground/25 hover:bg-accent/50",
        )}
      >
        <motion.div
          animate={dragging ? { y: -2 } : { y: 0 }}
          className="relative grid size-11 place-items-center rounded-lg border bg-card text-foreground shadow-card"
        >
          <ImagePlus className="size-5" />
        </motion.div>
        <div className="relative">
          <p className="text-sm font-medium">{dragging ? "Drop to scan" : "Drop QR code screenshots here"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Several at once is fine · or <span className="font-medium text-foreground underline-offset-2 group-hover:underline">browse files</span> · or paste with{" "}
            <kbd className="rounded-[4px] border bg-card px-1 font-mono text-[10px]">{modKey}V</kbd>
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <AnimatePresence initial={false}>
            {items.map((it) => (
              <motion.div
                key={it.id}
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                className="group/img relative flex items-center gap-2.5 rounded-lg border bg-card p-2 shadow-card"
              >
                <div className="relative size-11 shrink-0 overflow-hidden rounded-lg border bg-muted">
                  <img src={it.url} alt="" className="size-full object-cover" />
                  {it.status === "decoding" && (
                    <div className="absolute inset-0 grid place-items-center bg-background/70">
                      <Spinner className="size-4" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={it.name}>
                    {it.name}
                  </p>
                  <ImageStatus item={it} />
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${it.name}`}
                  className="absolute -top-1.5 -right-1.5 rounded-md border bg-card opacity-0 shadow-card group-hover/img:opacity-100 focus-visible:opacity-100"
                  onClick={() => onRemove(it.id)}
                >
                  <X />
                </Button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

function ImageStatus({ item }: { item: QrImage }) {
  if (item.status === "decoding") return <p className="text-[11px] text-muted-foreground">Scanning…</p>;
  if (item.status === "error")
    return (
      <p className="flex items-center gap-1 text-[11px] text-destructive">
        <CircleAlert className="size-3" /> {item.error ?? "Unreadable"}
      </p>
    );
  const otp = item.found.filter(isOtpUri).length;
  const other = item.found.length - otp;
  if (otp > 0)
    return (
      <p className="flex items-center gap-1 text-[11px] text-success">
        <CircleCheck className="size-3" /> {otp === 1 ? "1 code found" : `${otp} codes found`}
      </p>
    );
  if (other > 0)
    return (
      <p className="flex items-center gap-1 text-[11px] text-warning">
        <QrCode className="size-3" /> Not a 2FA QR code
      </p>
    );
  return (
    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <CircleAlert className="size-3" /> No QR code found
    </p>
  );
}

/** Tiny hint row shown under the drop zone. */
export function PasteHint() {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <ClipboardPaste className="size-3.5" /> Tip: take a screenshot to the clipboard and press {modKey}V right here.
    </p>
  );
}
