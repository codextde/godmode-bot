import { useMemo } from "react";
import { encode, QrCodeDataType } from "uqr";
import { cn } from "@/lib/utils";

const MARGIN = 2;
const INK = "#1c1c1c";

/** A QR code drawn as soft dots with rounded finder marks (always dark on white, so every camera reads it). */
export function QrCode({ value, className, label }: { value: string; className?: string; label: string }) {
  const qr = useMemo(() => encode(value, { ecc: "M", border: 0 }), [value]);
  const n = qr.size;
  const size = n + MARGIN * 2;

  const dots = useMemo(() => {
    const out: string[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!qr.data[y]![x] || qr.types[y]![x] === QrCodeDataType.Position) continue;
        out.push(`M${x + MARGIN + 0.5} ${y + MARGIN + 0.5}m-0.43 0a0.43 0.43 0 1 0 0.86 0a0.43 0.43 0 1 0 -0.86 0`);
      }
    }
    return out.join("");
  }, [qr, n]);

  const finders = [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ] as const;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={cn("block", className)}>
      <rect width={size} height={size} rx={2.5} fill="#ffffff" />
      <path d={dots} fill={INK} />
      {finders.map(([fx, fy]) => (
        <g key={`${fx}-${fy}`} transform={`translate(${fx + MARGIN} ${fy + MARGIN})`}>
          <rect x={0.5} y={0.5} width={6} height={6} rx={1.9} fill="none" stroke={INK} strokeWidth={1} />
          <rect x={2} y={2} width={3} height={3} rx={0.85} fill={INK} />
        </g>
      ))}
    </svg>
  );
}
