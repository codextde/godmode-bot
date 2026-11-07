import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

const subscribe = (onChange: () => void) => {
  const sub = AppState.addEventListener("change", onChange);
  return () => sub.remove();
};
const active = () => AppState.currentState !== "background" && AppState.currentState !== "inactive";

/** False while the app isn't in front (the app switcher, the background): secrets on screen hide so its snapshot doesn't keep them. */
export const useAppActive = () => useSyncExternalStore(subscribe, active);
