import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MAX_INSTRUCTIONS_LENGTH, type Agent, type ConversationWithMessages } from "@godmode/shared";
import { Group, PickerRow, TextEditor } from "@/components/form";
import { ErrorState, Skeleton, T } from "@/components/ui";
import { ApiError, api, errorText, updateDesktopMessage, type ChatPlacePatch } from "@/lib/api";
import { fetchConversation } from "@/lib/chat-cache";
import { fallbackProfile, useNewChatOptions } from "@/lib/chat-options";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { projectsFor, useProjectIndex, useWorkspace } from "@/lib/workspace";

const OWN = "__own";

/**
 * Where a chat works and what it keeps in mind: its project, browser profile and standing instructions. For a chat that
 * runs they apply from its next step; from the compose sheet (no `conversationId`) they go along with the new chat.
 */
export default function ChatOptionsSheet() {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const { conversationId, agentId, workspaceId } = useLocalSearchParams<{ conversationId?: string; agentId?: string; workspaceId?: string }>();
  const conversation = useQuery({
    queryKey: qk.conversation(conversationId ?? ""),
    queryFn: () => fetchConversation(conversationId!),
    enabled: !!conversationId,
    staleTime: Infinity,
  });
  const { byId } = useAgents();
  const options = useNewChatOptions((s) => s.options);
  const data = conversation.data;
  const agent = byId.get(data?.agentId ?? agentId ?? "");

  const save = async (patch: ChatPlacePatch, quiet = false): Promise<boolean> => {
    if (!conversationId) {
      useNewChatOptions.getState().set({
        ...(patch.browserProfileId !== undefined ? { browserProfileId: patch.browserProfileId } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      });
      return true;
    }
    try {
      const next = await api.conversations.update(conversationId, patch);
      queryClient.setQueryData<ConversationWithMessages>(qk.conversation(conversationId), (old) =>
        old ? { ...old, projectId: next.projectId, workspaceId: next.workspaceId, browserProfileId: next.browserProfileId, instructions: next.instructions } : old,
      );
      void queryClient.invalidateQueries({ queryKey: qk.conversations, predicate: (q) => q.queryKey[1] !== "detail" });
      return true;
    } catch (err) {
      const forbidden = err instanceof ApiError && err.code === "device_forbidden";
      if (!quiet || forbidden) Alert.alert(t("options.changeFailed"), forbidden ? updateDesktopMessage() : errorText(err));
      return false;
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: c.background }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <T variant="title">{t("options.title")}</T>
      {conversationId && !data ? (
        conversation.isError ? (
          <ErrorState title={t("options.loadFailed")} error={errorText(conversation.error)} onRetry={() => void conversation.refetch()} />
        ) : (
          <View style={{ gap: space.md }} accessibilityRole="progressbar">
            <Skeleton height={52} radius={14} />
            <Skeleton height={52} radius={14} />
            <Skeleton height={160} radius={14} />
          </View>
        )
      ) : (
        <>
          {data || agent ? (
            <Place
              agent={agent}
              workspaceId={data ? (data.workspaceId ?? null) : (workspaceId ?? null)}
              projectId={data?.projectId ?? null}
              profileId={data ? (data.browserProfileId ?? null) : options.browserProfileId}
              withProject={!!data}
              onChange={(patch) => void save(patch)}
            />
          ) : null}
          <View style={{ gap: space.sm }}>
            <T variant="eyebrow" muted style={{ paddingHorizontal: 4 }}>
              {t("options.instructions")}
            </T>
            <TextEditor
              key={conversationId ?? "new"}
              label={t("options.instructions")}
              value={data ? data.instructions : options.instructions}
              onSave={(next) => save({ instructions: next }, true)}
              placeholder={t("options.instructionsPlaceholder")}
              maxLength={MAX_INSTRUCTIONS_LENGTH}
            />
          </View>
        </>
      )}
    </ScrollView>
  );
}

/** The chat's project (an open chat only) and browser profile, each with the agent's own as the first choice. */
function Place({
  agent,
  workspaceId,
  projectId,
  profileId,
  withProject,
  onChange,
}: {
  agent?: Agent;
  workspaceId: string | null;
  projectId: string | null;
  profileId: string | null;
  withProject: boolean;
  onChange: (patch: ChatPlacePatch) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const settings = useSettings();
  const { workspaces } = useWorkspace();
  const index = useProjectIndex();
  const browsing = !!agent?.browser.enabled && settings.data?.browser.enabled !== false;
  const profiles = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles, enabled: browsing });

  const projects = withProject ? projectsFor(agent, workspaces, workspaceId) : [];
  const agentProject = agent?.projectId ? index.get(agent.projectId)?.project : undefined;
  const project = (projectId ? index.get(projectId)?.project : agentProject) ?? null;
  const home = agent?.workspaceId ?? project?.workspaceId ?? workspaceId;
  const usable = (profiles.data ?? []).filter((p) => !p.workspaceId || p.workspaceId === home);
  const fallback = agent ? fallbackProfile(agent, profiles.data ?? [], workspaceId, project) : null;
  // Only when there is something to pick besides the profile it browses with anyway.
  const showProfiles = browsing && (usable.some((p) => p.id !== fallback?.id) || !!profileId);
  if (!projects.length && !showProfiles) return null;

  return (
    <Group>
      {projects.length ? (
        <PickerRow
          icon="folder"
          title={t("options.project")}
          value={projectId && projectId !== agentProject?.id ? projectId : OWN}
          options={[
            { value: OWN, label: agentProject ? t("options.agentProject", { name: agent?.name ?? "" }) : t("options.noProject"), detail: agentProject?.name },
            ...projects.filter((p) => p.id !== agentProject?.id).map((p) => ({ value: p.id, label: p.icon ? `${p.icon} ${p.name}` : p.name })),
          ]}
          onChange={(v) => onChange({ projectId: v === OWN ? null : v })}
        />
      ) : null}
      {showProfiles ? (
        <PickerRow
          icon="globe"
          title={t("options.browser")}
          value={profileId ?? OWN}
          options={[
            { value: OWN, label: fallback && fallback.name.toLowerCase() !== "default" ? t("options.defaultNamed", { name: fallback.name }) : t("options.defaultProfile") },
            ...usable.filter((p) => p.id !== fallback?.id || profileId === p.id).map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(v) => onChange({ browserProfileId: v === OWN ? null : v })}
        />
      ) : null}
    </Group>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.xl, paddingBottom: 48, gap: space.lg },
});
