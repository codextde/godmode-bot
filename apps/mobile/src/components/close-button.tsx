import { router, useNavigation } from "expo-router";
import { useTranslation } from "react-i18next";
import { HeaderActions } from "./header-actions";

/** Closes the settings sheet from the first screen in it (the others go back). */
export function CloseButton() {
  const navigation = useNavigation();
  const { t } = useTranslation("common");
  if ((navigation.getState()?.index ?? 0) > 0) return null;
  return <HeaderActions placement="left" actions={[{ icon: "close", label: t("actions.close"), onPress: () => router.back() }]} />;
}
