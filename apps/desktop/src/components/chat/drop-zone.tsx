import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FileText, ImageIcon, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { usePageScroll } from "@/components/layout/page-scroll";
import { cn } from "@/lib/utils";

/** Dragovers keep coming while files hover. Without one for this long the drag is over, however it ended. */
const DRAG_TIMEOUT = 1500;

/** The files of a drop, and how many folders came along: those can't be read. */
function readDrop(data: DataTransfer): { files: File[]; folders: number } {
  const items = Array.from(data.items ?? []).filter((i) => i.kind === "file");
  if (items.length === 0) return { files: Array.from(data.files), folders: 0 };
  const folders = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory);
  return { files: items.filter((i) => !folders.includes(i)).flatMap((i) => i.getAsFile() ?? []), folders: folders.length };
}

function pointerInside(el: HTMLElement, e: DragEvent): boolean {
  const r = el.getBoundingClientRect();
  return e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
}

/** Full-area file drop target: dragging files over the chat turns it into a drop surface. */
export function ChatDropZone({
  onFiles,
  disabled,
  children,
  className,
}: {
  onFiles: (files: File[]) => void;
  /** Nothing to attach to right now */
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [over, setOver] = useState(false);
  const catcherRef = useRef<HTMLDivElement>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pageDrag = useRef(false);
  const hide = () => {
    clearTimeout(watchdog.current);
    setOver(false);
  };

  // A drag that starts in the page (a picture pulled out of the thread) claims to carry files too: it is not one
  // coming in. Kept as a flag, since writing a mark into the drag would replace what WebKit puts in it.
  useEffect(() => {
    const ended = () => {
      pageDrag.current = false;
    };
    const started = () => {
      pageDrag.current = true;
      // The source may be gone by the time the drag ends. No mouse moves reach the page during a drag, so the next
      // one means it is over.
      window.addEventListener("mousemove", ended, { capture: true, once: true });
    };
    window.addEventListener("dragstart", started, true);
    window.addEventListener("dragend", ended, true);
    return () => {
      window.removeEventListener("dragstart", started, true);
      window.removeEventListener("dragend", ended, true);
      window.removeEventListener("mousemove", ended, true);
      clearTimeout(watchdog.current);
    };
  }, []);

  // Files from outside, over the chat itself: dialogs and menus opened from it are React children too, but not part
  // of the drop surface.
  const mine = (e: DragEvent<HTMLDivElement>) =>
    !disabled && !pageDrag.current && Array.from(e.dataTransfer.types).includes("Files") && e.currentTarget.contains(e.target as Node);
  const show = (e: DragEvent<HTMLDivElement>) => {
    if (!mine(e)) return;
    e.preventDefault();
    setOver(true);
    clearTimeout(watchdog.current);
    watchdog.current = setTimeout(hide, DRAG_TIMEOUT);
  };
  const active = over && !disabled;

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={show}
      onDragOver={show}
      onDragLeave={(e) => {
        // Once up, the catcher is all there is under the pointer: leaving it is leaving the chat. Before that, the
        // leaves of the elements crossed on the way in only count when the pointer is outside.
        if (e.target === catcherRef.current || !pointerInside(e.currentTarget, e)) hide();
      }}
      onDrop={(e) => {
        hide();
        if (!mine(e)) return;
        e.preventDefault();
        const { files, folders } = readDrop(e.dataTransfer);
        if (files.length) onFiles(files);
        if (folders) toast.warning("Folders can't be attached — drop the files inside instead.");
      }}
    >
      {children}
      {/* Always mounted: the drop goes to the element the files were last over, even when it comes after the timeout
          (files that have to be fetched first). Gone from the page, it would reach nobody. */}
      <div ref={catcherRef} aria-hidden className={cn("absolute inset-0 z-50", !active && "pointer-events-none")}>
        <AnimatePresence>{active && <DropSurface />}</AnimatePresence>
      </div>
    </div>
  );
}

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

function DropSurface() {
  const reduce = useReducedMotion();
  // On a page that scrolls as a whole, the surface stays with what is on screen.
  const viewport = usePageScroll()?.clientHeight;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="pointer-events-none sticky top-0 h-full max-h-svh bg-background/80 p-3 backdrop-blur-sm"
      style={{ maxHeight: viewport }}
    >
      <motion.div
        initial={reduce ? false : { scale: 0.985 }}
        animate={{ scale: 1 }}
        transition={SPRING}
        className="relative grid size-full place-items-center rounded-2xl bg-brand/[0.07] p-6 text-center"
      >
        <svg className="absolute inset-0 size-full overflow-visible text-brand" fill="none">
          <rect
            width="100%"
            height="100%"
            rx="16"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="8 7"
            strokeLinecap="round"
            className="motion-safe:animate-march"
          />
        </svg>
        <div className="relative flex flex-col items-center">
          <div className="relative h-[76px] w-36">
            {[ImageIcon, FileText].map((Icon, i) => {
              const side = i === 0 ? -1 : 1;
              return (
                <motion.span
                  key={i}
                  initial={reduce ? false : { x: 0, y: 10, rotate: 0, opacity: 0 }}
                  animate={{ x: side * 38, y: 6, rotate: side * 11, opacity: 1 }}
                  transition={{ ...SPRING, delay: 0.04 }}
                  className="absolute inset-x-0 top-0 mx-auto grid h-[68px] w-[54px] place-items-center rounded-xl border bg-card text-muted-foreground shadow-card"
                >
                  <Icon className="size-5" />
                </motion.span>
              );
            })}
            <motion.span
              initial={reduce ? false : { y: 12, scale: 0.9, opacity: 0 }}
              animate={{ y: 0, scale: 1, opacity: 1 }}
              transition={SPRING}
              className="absolute inset-x-0 top-0 mx-auto h-[68px] w-[54px]"
            >
              <motion.span
                animate={reduce ? undefined : { y: [0, -5, 0] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                className="grid size-full place-items-center rounded-xl border border-brand/50 bg-card text-brand-strong shadow-float"
              >
                <Paperclip className="size-6" />
              </motion.span>
            </motion.span>
          </div>
          <motion.div
            initial={reduce ? false : { y: 6, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ ...SPRING, delay: 0.05 }}
            className="mt-4"
          >
            <div className="text-[17px] font-medium tracking-[-0.01em]">Drop files to attach</div>
            <div className="mt-1 text-sm text-muted-foreground">Images, PDFs, spreadsheets… up to 25 MB each</div>
          </motion.div>
        </div>
      </motion.div>
    </motion.div>
  );
}
