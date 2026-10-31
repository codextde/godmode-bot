import * as SecureStore from "expo-secure-store";
import { Alert } from "react-native";
import { create } from "zustand";

const KEY = "godmode.hideSuggestions";

interface SuggestionsState {
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
}

export const useSuggestions = create<SuggestionsState>((set) => ({
  hidden: false,
  setHidden: (hidden) => {
    set({ hidden });
    void SecureStore.setItemAsync(KEY, hidden ? "1" : "0").catch(() => undefined);
  },
}));

void SecureStore.getItemAsync(KEY)
  .catch(() => null)
  .then((saved) => {
    if (saved === "1") useSuggestions.setState({ hidden: true });
  });

export function confirmHideSuggestions() {
  Alert.alert("Hide suggestions?", "Show them again anytime in Settings → App.", [
    { text: "Cancel", style: "cancel" },
    { text: "Hide", onPress: () => useSuggestions.getState().setHidden(true) },
  ]);
}
