import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { Project, Workspace } from "@godmode/shared";
import { Group } from "@/components/form";
import { NeedsFullAccess, useFullAccess } from "@/components/full-access";
import { PickRow, PickSheet } from "@/components/pick-sheet";
import { EmptyState, LoadingState } from "@/components/ui";
import { moveScope, type ScopeMove } from "@/lib/manage";
import { useWorkspace, ownEmoji } from "@/lib/workspace";

/** An agent wrote the project's context: as a workspace's it reaches every run there, so the human reads it first. */
const needsReview = (p: Project) => (p.fillOnly || p.offComputer) && !!(p.instructions.trim() || p.description.trim());

const clip = (text: string, max = 700) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/**
 * The desktop workspace page's moves: a workspace into another (it becomes a project there), a project into another
 * workspace or out on its own. The computer asks for the vault password when logins or cards change hands.
 */
export default function ScopeMoveSheet() {
  const { t } = useTranslation(["manage", "common"]);
  const { kind, id } = useLocalSearchParams<{ kind: "workspace" | "project"; id: string }>();
  const { workspaces, loading } = useWorkspace();
  const { fullAccess } = useFullAccess();
  const [busy, setBusy] = useState(false);
  const workspace = kind === "workspace" ? workspaces.find((w) => w.id === id) : undefined;
  const home = kind === "project" ? workspaces.find((w) => w.projects.some((p) => p.id === id)) : undefined;
  const project = home?.projects.find((p) => p.id === id);
  const title = kind === "workspace" ? t("scope.moveInto") : t("scope.moveTo");

  if (fullAccess === false) {
    return (
      <PickSheet title={title}>
        <NeedsFullAccess />
      </PickSheet>
    );
  }
  if (!workspace && !project) {
    return <PickSheet title={title}>{loading ? <LoadingState /> : <EmptyState icon="layers" title={t("scope.gone")} />}</PickSheet>;
  }

  const run = async (move: ScopeMove, done: string) => {
    setBusy(true);
    const res = await moveScope(move, done);
    setBusy(false);
    if (res === "review" && project && move.kind === "project") return review(project, () => void run({ ...move, reviewed: true }, done));
    if (!res || res === "review") return;
    router.back();
    // What it became lives on another screen now.
    if (move.kind === "workspace" && res.project) router.replace({ pathname: "/settings/project/[id]", params: { id: res.project.id } });
    if (move.kind === "project" && !move.to) router.replace({ pathname: "/settings/workspace/[id]", params: { id: res.workspace.id } });
  };

  const review = (p: Project, go: () => void) =>
    Alert.alert(t("scope.review.title", { name: p.name }), `${t("scope.review.body")}\n\n${clip([p.description.trim(), p.instructions.trim()].filter(Boolean).join("\n\n"))}`, [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("scope.makeWorkspace"), onPress: go },
    ]);

  if (workspace) {
    const others = workspaces.filter((w) => w.id !== workspace.id);
    const nest = (to: Workspace) =>
      Alert.alert(t("scope.nest.title", { name: workspace.name, to: to.name }), t("scope.nest.body", { name: workspace.name, to: to.name }), [
        { text: t("common:actions.cancel"), style: "cancel" },
        { text: t("scope.nest.confirm"), onPress: () => void run({ kind: "workspace", id: workspace.id, to: to.id }, t("scope.doneNest", { name: workspace.name, to: to.name })) },
      ]);
    return (
      <PickSheet title={title}>
        {others.length ? (
          <Group title={t("scope.becomesProjectOf")}>
            {others.map((w) => (
              <PickRow key={w.id} emoji={ownEmoji(w.icon)} icon="layers" title={w.name} detail={w.description || undefined} selected={false} disabled={busy} onPress={() => nest(w)} />
            ))}
          </Group>
        ) : (
          <EmptyState icon="layers" title={t("scope.noOther")} />
        )}
      </PickSheet>
    );
  }

  const p = project!;
  const makeWorkspace = () => {
    const move: ScopeMove = { kind: "project", id: p.id, to: null };
    const done = t("scope.doneWorkspace", { name: p.name });
    if (needsReview(p)) review(p, () => void run({ ...move, reviewed: true }, done));
    else void run(move, done);
  };
  return (
    <PickSheet title={title}>
      <Group>
        <PickRow icon="layers" title={t("scope.makeWorkspace")} selected={false} disabled={busy} onPress={makeWorkspace} />
      </Group>
      {workspaces.length > 1 ? (
        <Group>
          {workspaces.map((w) => (
            <PickRow
              key={w.id}
              emoji={ownEmoji(w.icon)} icon="layers"
              title={w.name}
              detail={w.description || undefined}
              selected={w.id === home?.id}
              disabled={busy}
              onPress={() => (w.id === home?.id ? router.back() : void run({ kind: "project", id: p.id, to: w.id }, t("scope.doneMoved", { name: p.name, to: w.name })))}
            />
          ))}
        </Group>
      ) : null}
    </PickSheet>
  );
}
