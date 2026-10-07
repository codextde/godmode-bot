import { useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/lib/hooks";
import { faviconUrl, hueFor, isPrivateHost } from "./vault-utils";

const missingIcons = new Set<string>();

/**
 * Site icon with graceful fallback to a flat, softly tinted initial tile.
 * Google's favicon service returns a generic globe for unknown sites (16px) — we treat tiny images as missing.
 */
export function Favicon({
  domain,
  name,
  size = "md",
  className,
}: {
  domain?: string | null;
  name: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const [failed, setFailed] = useState(() => !!domain && missingIcons.has(domain));
  const markFailed = () => {
    if (domain) missingIcons.add(domain);
    setFailed(true);
  };
  const { data: settings } = useSettings();
  const iconsAllowed = settings?.security.fetchSiteIcons !== false;
  const sizes = { xs: "size-5 rounded-[5px] text-[10px]", sm: "size-6 rounded-md text-[11px]", md: "size-9 rounded-lg text-sm", lg: "size-12 rounded-xl text-lg" };
  const initial = (name || domain || "?").trim().charAt(0).toUpperCase() || "?";
  const hue = hueFor((domain || name || "?").toLowerCase());
  const showImg = !!domain && !failed && iconsAllowed && !isPrivateHost(domain);
  return (
    <div
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden font-medium ring-1 ring-inset",
        sizes[size],
        showImg
          ? "bg-white shadow-card ring-border"
          : "bg-[oklch(0.66_0.1_var(--fav-h)/0.14)] text-[oklch(0.45_0.1_var(--fav-h))] ring-[oklch(0.5_0.1_var(--fav-h)/0.16)] dark:text-[oklch(0.84_0.08_var(--fav-h))]",
        className,
      )}
      style={showImg ? undefined : ({ "--fav-h": hue } as CSSProperties)}
      aria-hidden
    >
      {showImg ? (
        <img
          src={faviconUrl(domain!, 64)}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-[62%] object-contain"
          onLoad={(e) => {
            if (e.currentTarget.naturalWidth <= 16) markFailed();
          }}
          onError={markFailed}
        />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  );
}
