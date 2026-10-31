"use client";

import { useTranslation } from "react-i18next";
import styles from "./ThinkingState.module.css";

export function ThinkingState() {
  const { t } = useTranslation("aicss");
  return <span className={styles.shimmer}>{t("thinking")}</span>;
}
