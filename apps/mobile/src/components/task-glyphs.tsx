import { memo } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import type { TaskPriority, TaskStatus } from "@godmode/shared";
import { alpha, useColors, type Colors } from "@/lib/theme";

/** The desktop's status colours (task-meta.tsx): in progress amber, in review emerald, blocked rose, done sky. */
export function statusColor(c: Colors, status: TaskStatus): string {
  switch (status) {
    case "todo":
      return alpha(c.text, 0.7);
    case "in_progress":
      return c.amberMark;
    case "in_review":
      return c.emeraldMark;
    case "blocked":
      return c.roseMark;
    case "done":
      return c.skyMark;
    default:
      return c.textMuted;
  }
}

/** Linear-style status glyph, drawn like the desktop's: dashed ring, ring, half, three quarters, struck, check, cross. */
export const StatusIcon = memo(function StatusIcon({ status, size = 14, color }: { status: TaskStatus; size?: number; color?: string }) {
  const c = useColors();
  const fg = color ?? statusColor(c, status);
  const ring = <Circle cx={8} cy={8} r={6} stroke={fg} strokeWidth={1.5} fill="none" />;
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {status === "backlog" ? (
        <Circle cx={8} cy={8} r={6} stroke={fg} strokeWidth={1.5} strokeDasharray="1.4 2.1" fill="none" />
      ) : status === "done" ? (
        <>
          <Circle cx={8} cy={8} r={7} fill={fg} />
          <Path d="m5 8.2 2 2 4-4.2" stroke={c.background} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      ) : (
        <>
          {ring}
          {status === "in_progress" ? <Path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill={fg} /> : null}
          {status === "in_review" ? <Path d="M8 4.5a3.5 3.5 0 1 1-3.5 3.5H8z" fill={fg} /> : null}
          {status === "blocked" ? <Path d="m4 4 8 8" stroke={fg} strokeWidth={1.5} /> : null}
          {status === "cancelled" ? <Path d="m6 6 4 4m0-4-4 4" stroke={fg} strokeWidth={1.5} strokeLinecap="round" fill="none" /> : null}
        </>
      )}
    </Svg>
  );
});

export function priorityColor(c: Colors, priority: TaskPriority): string {
  if (priority === "urgent") return c.rose;
  if (priority === "high") return alpha(c.text, 0.8);
  if (priority === "medium") return alpha(c.text, 0.7);
  return c.textMuted;
}

/** Linear-style priority glyph: a filled square with "!" for urgent, three / two / one bars, three dots for none. */
export const PriorityIcon = memo(function PriorityIcon({ priority, size = 14 }: { priority: TaskPriority; size?: number }) {
  const c = useColors();
  const fg = priorityColor(c, priority);
  const bars = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill={fg} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {priority === "urgent" ? (
        <>
          <Rect x={1.5} y={1.5} width={13} height={13} rx={3} fill={fg} />
          <Path d="M8 4.5v4.5" stroke={c.background} strokeWidth={1.8} strokeLinecap="round" />
          <Circle cx={8} cy={11.4} r={1} fill={c.background} />
        </>
      ) : priority === "none" ? (
        <>
          <Circle cx={3.5} cy={8} r={1.2} fill={fg} />
          <Circle cx={8} cy={8} r={1.2} fill={fg} />
          <Circle cx={12.5} cy={8} r={1.2} fill={fg} />
        </>
      ) : (
        [0, 1, 2].map((i) => <Rect key={i} x={2 + i * 4.5} y={10 - i * 3.5} width={3} height={4 + i * 3.5} rx={1} fill={fg} opacity={i < bars ? 1 : 0.25} />)
      )}
    </Svg>
  );
});
