import { useUi } from "@/stores/ui";

export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

export const PANEL = { duration: 0.2, ease: EASE_OUT } as const;

export const useReduceAnimations = () => useUi((s) => s.reduceAnimations);
