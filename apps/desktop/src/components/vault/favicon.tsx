import { useState } from "react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/lib/hooks";
import { faviconUrl, hueFor, isPrivateHost } from "./vault-utils";

/**
 * Site icon with graceful fallback to a colored initial tile.
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
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const { data: settings } = useSettings();
  const iconsAllowed = settings?.security.fetchSiteIcons !== false;
  const sizes = { sm: "size-6 rounded-md text-[11px]", md: "size-9 rounded-xl text-sm", lg: "size-12 rounded-2xl text-lg" };
  const initial = (name || domain || "?").trim().charAt(0).toUpperCase() || "?";
  const hue = hueFor((domain || name || "?").toLowerCase());
  const showImg = !!domain && !failed && iconsAllowed && !isPrivateHost(domain);
  return (
    <div
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden font-semibold text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10",
        sizes[size],
        showImg && "bg-white",
        className,
      )}
      style={showImg ? undefined : { background: `linear-gradient(135deg, oklch(0.68 0.16 ${hue}), oklch(0.52 0.19 ${(hue + 40) % 360}))` }}
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
            if (e.currentTarget.naturalWidth <= 16) setFailed(true);
          }}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="drop-shadow-sm">{initial}</span>
      )}
    </div>
  );
}
