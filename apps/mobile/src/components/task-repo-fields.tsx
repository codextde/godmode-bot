import { StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { WorkspaceSource } from "@godmode/shared";
import { Group, PickerRow } from "./form";
import { T } from "./ui";
import { sourceLabel } from "@/lib/desktop-parity";
import { fonts, space, textScale, useColors } from "@/lib/theme";

export const OTHER_REPO = "__other";

/** A line of code-like text whose value counts as it is typed (the form's Save may come before the field is left). */
export function CodeRow({ label, value, onChange, placeholder, keyboardType }: { label: string; value: string; onChange: (next: string) => void; placeholder?: string; keyboardType?: "url" }) {
  const c = useColors();
  return (
    <View style={styles.row}>
      <T variant="footnote" muted>
        {label}
      </T>
      <TextInput
        accessibilityLabel={label}
        maxFontSizeMultiplier={textScale.label}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.textFaint}
        keyboardType={keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        style={[styles.input, { color: c.text }]}
      />
    </View>
  );
}

/** Where a new coding ticket works: one of the workspace's repositories or another URL, and the branch it starts from. */
export function TaskRepoFields({
  repos,
  choice,
  url,
  baseBranch,
  onChoice,
  onUrl,
  onBaseBranch,
}: {
  repos: WorkspaceSource[];
  choice: string;
  url: string;
  baseBranch: string;
  onChoice: (next: string) => void;
  onUrl: (next: string) => void;
  onBaseBranch: (next: string) => void;
}) {
  const { t } = useTranslation("tasks");
  const picked = repos.find((r) => r.id === choice);
  return (
    <Group>
      {repos.length > 0 ? (
        <PickerRow
          icon="branch"
          title={t("task.repository")}
          value={choice}
          options={[...repos.map((r) => ({ value: r.id, label: sourceLabel(r), detail: r.branch ?? undefined })), { value: OTHER_REPO, label: t("repo.another") }]}
          onChange={onChoice}
        />
      ) : null}
      {choice === OTHER_REPO ? <CodeRow label={t("repo.url")} value={url} onChange={onUrl} placeholder="https://github.com/acme/app.git" keyboardType="url" /> : null}
      <CodeRow label={t("repo.baseBranch")} value={baseBranch} onChange={onBaseBranch} placeholder={picked?.branch || t("task.defaultBranchShort")} />
    </Group>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 2,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  input: {
    fontFamily: fonts.mono,
    fontSize: 15,
    paddingVertical: 4,
  },
});
