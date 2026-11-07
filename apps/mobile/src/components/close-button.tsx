import { router, useNavigation } from "expo-router";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { HeaderActions } from "./header-actions";

/** Closes the settings sheet from the first screen in it (the others go back). */
export function CloseButton() {
  const navigation = useNavigation();
  const { t } = useTranslation("common");
  // Read from the store: while a screen is being pushed the stack still reports the one before it.
  const index = useSyncExternalStore(
    (changed) => navigation.addListener("state", changed),
    () => navigation.getState()?.index ?? 0,
  );
  if (index > 0) return null;
  return <HeaderActions placement="left" actions={[{ icon: "close", label: t("actions.close"), onPress: () => router.back() }]} />;
}
