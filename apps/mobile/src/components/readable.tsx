import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";

/** The widest a screen's content runs, like Apple's readable width: an iPad or a phone held sideways gets a centered column. */
const READABLE_WIDTH = 760;

/** Screens that bring their own navigator, which lays out its own screens. */
const NESTED = new Set(["(tabs)", "settings"]);

/**
 * A navigator's `screenLayout`: pushed screens keep to the readable column. Sheets and full-screen modals (camera, live
 * view) keep their own width. The wrapper only sets layout, so it is flattened away and never changes the native views.
 */
export function readableLayout({ route, options, children }: { route: { name: string }; options: { presentation?: string }; children: ReactElement }) {
  const own = NESTED.has(route.name) || (options.presentation !== undefined && options.presentation !== "card");
  return <View style={own ? styles.full : styles.column}>{children}</View>;
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  column: { flex: 1, width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center" },
});
