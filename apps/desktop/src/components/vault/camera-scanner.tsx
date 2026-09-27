import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Camera, CameraOff, CircleCheck, QrCode, RefreshCw, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isOtpUri, parseOtpUri, scanVideoFrame } from "@/lib/qr";
import { cn } from "@/lib/utils";

type CameraState = "starting" | "live" | "denied" | "notfound" | "unsupported" | "error";

const SCAN_INTERVAL_MS = 150;

function describe(uri: string): string {
  const p = parseOtpUri(uri);
  if (p.kind === "otpauth") return p.preview.issuer;
  if (p.kind === "migration") return `${p.preview.accounts.length} account${p.preview.accounts.length === 1 ? "" : "s"} from Google Authenticator`;
  return "code";
}

/**
 * Live camera QR scanner. Every newly detected otpauth(-migration) payload is passed to `onCode`;
 * scanning continues so several codes (e.g. a multi-part export) can be captured in one go.
 */
export function CameraScanner({ known, onCode }: { known: Set<string>; onCode: (uri: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<CameraState>("starting");
  const [errorText, setErrorText] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [flash, setFlash] = useState<{ kind: "added" | "not-otp" | "duplicate"; text: string; at: number } | null>(null);

  const knownRef = useRef(known);
  knownRef.current = known;
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    let lastScan = 0;
    let lastIgnored = "";

    const stop = () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const loop = (t: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!video || video.readyState < 2 || t - lastScan < SCAN_INTERVAL_MS) return;
      lastScan = t;
      canvasRef.current ??= document.createElement("canvas");
      const payload = scanVideoFrame(video, canvasRef.current);
      if (!payload) return;
      if (!isOtpUri(payload)) {
        if (lastIgnored !== payload) {
          lastIgnored = payload;
          setFlash({ kind: "not-otp", text: "That QR code isn't a 2FA code", at: Date.now() });
        }
        return;
      }
      if (knownRef.current.has(payload)) {
        if (lastIgnored !== payload) {
          lastIgnored = payload;
          setFlash({ kind: "duplicate", text: "Already added", at: Date.now() });
        }
        return;
      }
      lastIgnored = payload;
      onCodeRef.current(payload);
      setFlash({ kind: "added", text: `Added ${describe(payload)}`, at: Date.now() });
    };

    (async () => {
      setState("starting");
      if (!navigator.mediaDevices?.getUserMedia) {
        setState("unsupported");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          stop();
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        setState("live");
        raf = requestAnimationFrame(loop);
        const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
        if (!cancelled) setDevices(all.filter((d) => d.kind === "videoinput" && d.deviceId));
      } catch (e) {
        if (cancelled) return;
        const name = e instanceof DOMException ? e.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") setState("denied");
        else if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") setState("notfound");
        else {
          setState("error");
          setErrorText(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [deviceId, attempt]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash((f) => (f?.at === flash.at ? null : f)), 1800);
    return () => clearTimeout(id);
  }, [flash]);

  if (state === "denied" || state === "notfound" || state === "unsupported" || state === "error") {
    const content = {
      denied: {
        icon: <CameraOff />,
        title: "Camera access was blocked",
        text: "Allow camera access for Godmode (on macOS: System Settings → Privacy & Security → Camera), then try again. Or drop a screenshot instead.",
      },
      notfound: { icon: <VideoOff />, title: "No camera found", text: "Connect a camera, or take a screenshot of the QR code and drop it on the Images tab." },
      unsupported: { icon: <VideoOff />, title: "Camera not available here", text: "This window can't access cameras. Use screenshots on the Images tab instead." },
      error: { icon: <CameraOff />, title: "Couldn't start the camera", text: errorText || "Something went wrong while opening the camera." },
    }[state];
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center">
        <div className="grid size-11 place-items-center rounded-lg border bg-card text-foreground shadow-card [&_svg]:size-5">{content.icon}</div>
        <div>
          <p className="text-sm font-medium">{content.title}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{content.text}</p>
        </div>
        {state !== "unsupported" && (
          <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
            <RefreshCw /> Try again
          </Button>
        )}
      </div>
    );
  }

  const frameTone = flash?.kind === "added" ? "border-success" : flash?.kind === "not-otp" ? "border-warning" : "border-white/85";

  return (
    <div className="space-y-2">
      <div className="relative aspect-video overflow-hidden rounded-xl border bg-black">
        <video ref={videoRef} muted playsInline className="size-full object-cover" aria-label="Camera preview" />
        {state === "starting" && (
          <div className="absolute inset-0 grid place-items-center text-white/80">
            <div className="flex items-center gap-2 text-sm">
              <Spinner /> Starting camera…
            </div>
          </div>
        )}
        {/* Scan frame */}
        <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="relative aspect-square h-[68%]">
            <div className="absolute inset-0 rounded-xl shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
            {["top-0 left-0 border-t-[3px] border-l-[3px] rounded-tl-xl", "top-0 right-0 border-t-[3px] border-r-[3px] rounded-tr-xl", "bottom-0 left-0 border-b-[3px] border-l-[3px] rounded-bl-xl", "bottom-0 right-0 border-b-[3px] border-r-[3px] rounded-br-xl"].map((c) => (
              <div key={c} className={cn("absolute size-10 transition-colors duration-300", frameTone, c)} />
            ))}
            {state === "live" && (
              <motion.div
                className="absolute inset-x-4 h-0.5 bg-brand"
                initial={{ top: "8%" }}
                animate={{ top: ["8%", "92%", "8%"] }}
                transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
          </div>
        </div>
        <AnimatePresence>
          {flash && (
            <motion.div
              key={flash.at}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className={cn(
                "absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-float",
                flash.kind === "added" ? "[&_svg]:text-success" : flash.kind === "not-otp" ? "[&_svg]:text-warning" : "[&_svg]:text-muted-foreground",
              )}
              role="status"
            >
              {flash.kind === "added" ? <CircleCheck className="size-3.5" /> : <QrCode className="size-3.5" />}
              {flash.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Camera className="size-3.5" /> Hold the QR code inside the frame — keep scanning to add several.
        </p>
        {devices.length > 1 && (
          <Select value={deviceId ?? devices[0]?.deviceId} onValueChange={setDeviceId}>
            <SelectTrigger size="sm" className="w-48" aria-label="Camera">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {devices.map((d, i) => (
                <SelectItem key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
