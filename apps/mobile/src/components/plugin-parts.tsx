import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { modAbilities, modHookLabel, type Agent, type Mod, type ModAbility, type ModContents, type ModHook, type ModIcon } from "@godmode/shared";
import { Group } from "./form";
import { Icon, type IconName } from "./icon";
import { T, tap } from "./ui";
import { t as translate } from "@/lib/i18n";
import { radius, space, useColors } from "@/lib/theme";

const ICONS: Record<ModIcon, IconName> = {
  puzzle: "puzzle",
  shield: "shield",
  "file-lock": "fileLock",
  terminal: "terminal",
  "eye-off": "eyeOff",
  gauge: "gauge",
  timer: "timer",
  "git-branch": "branch",
  scroll: "scrollText",
  bell: "bell",
  filter: "filter",
  wand: "wand",
  video: "video",
  layers: "layers",
  sparkles: "sparkles",
  bot: "subagent",
};

const ICON_LABELS = {
  puzzle: "pluginAdmin.icons.puzzle",
  shield: "pluginAdmin.icons.shield",
  "file-lock": "pluginAdmin.icons.fileLock",
  terminal: "pluginAdmin.icons.terminal",
  "eye-off": "pluginAdmin.icons.eyeOff",
  gauge: "pluginAdmin.icons.gauge",
  timer: "pluginAdmin.icons.timer",
  "git-branch": "pluginAdmin.icons.gitBranch",
  scroll: "pluginAdmin.icons.scroll",
  bell: "pluginAdmin.icons.bell",
  filter: "pluginAdmin.icons.filter",
  wand: "pluginAdmin.icons.wand",
  video: "pluginAdmin.icons.video",
  layers: "pluginAdmin.icons.layers",
  sparkles: "pluginAdmin.icons.sparkles",
  bot: "pluginAdmin.icons.bot",
} as const satisfies Record<ModIcon, string>;

export const pluginIcon = (icon: ModIcon): IconName => ICONS[icon] ?? "puzzle";

export const pluginIconLabel = (icon: ModIcon) => ICON_LABELS[icon];

export function hookLabel(hook: ModHook): string {
  if (hook.event === "tool.call") {
    const tool = hook.matcher ? /(?:^|,\s*)tool=([^,]+)/.exec(hook.matcher)?.[1] : null;
    if (tool) return translate("tools:pluginAdmin.hook.toolCalls", { tool });
  }
  return translate(`tools:pluginAdmin.hook.${hook.event.replace(/\./g, "_")}` as never, { defaultValue: modHookLabel(hook) });
}

/** Who added a plugin, in words: an agent by name when it still exists. */
export function pluginOrigin(mod: Pick<Mod, "origin" | "createdBy" | "source">, agents: readonly Agent[] | undefined): string {
  const authorId = mod.createdBy.startsWith("agent:") ? mod.createdBy.slice(6) : null;
  const author = authorId ? agents?.find((a) => a.id === authorId) : undefined;
  if (mod.origin === "git") {
    if (authorId) return author ? translate("tools:pluginAdmin.origin.installedBy", { name: author.name }) : translate("tools:pluginAdmin.origin.installedByAgent");
    return translate(mod.source?.web?.startsWith("https://github.com/") ? "tools:pluginAdmin.origin.installedFromGitHub" : "tools:pluginAdmin.origin.installedFromRepo");
  }
  if (mod.origin === "template") return translate("tools:pluginAdmin.origin.template");
  if (mod.origin === "import") return translate("tools:pluginAdmin.origin.imported");
  if (mod.origin === "agent") return author ? translate("tools:pluginAdmin.origin.draftedBy", { name: author.name }) : translate("tools:pluginAdmin.origin.draftedByAgent");
  return translate("tools:pluginAdmin.origin.yours");
}

/** The file (and line) a check problem's `where` points at: "hooks/register.ts:12", "plugin.json › userConfig.paths". */
export function problemTarget(where: string, paths: string[]): { path: string; line: number | null } | null {
  const longestFirst = [...paths].sort((a, b) => b.length - a.length);
  const follows = (prefix: string) => where === prefix || (where.startsWith(prefix) && /^[\s:›(,]/.test(where.slice(prefix.length)));
  const path = longestFirst.find(follows) ?? longestFirst.find((p) => follows(p.slice(p.lastIndexOf("/") + 1)));
  if (!path) return null;
  const line = /:(\d+)/.exec(where)?.[1];
  return { path, line: line ? Number(line) : null };
}

/** What a mod can do, in the app's language. */
function hookAbilities(mod: Mod): ModAbility[] {
  if (!mod.check) return [];
  return modAbilities(mod.check).map((a) => {
    const key = a.id.replace(/-/g, "_");
    return {
      ...a,
      label: translate(`tools:pluginAdmin.ability.${key}.label` as never, { defaultValue: a.label }),
      detail: translate(`tools:pluginAdmin.ability.${key}.detail` as never, { defaultValue: a.detail }),
    };
  });
}

function contentsAbilities(contents: ModContents | null): ModAbility[] {
  if (!contents) return [];
  const ability = (id: string, label: string, detail: string, level: ModAbility["level"]): ModAbility => ({ id, label, detail, level });
  const events = contents.hooks.slice(0, 4).join(", ");
  return [
    ...(contents.skills.length ? [ability("skills", translate("tools:pluginAdmin.abilities.skills", { count: contents.skills.length }), translate("tools:pluginAdmin.abilities.skillsDetail"), "normal")] : []),
    ...(contents.agents.length ? [ability("agents", translate("tools:pluginAdmin.abilities.subagents", { count: contents.agents.length }), translate("tools:pluginAdmin.abilities.subagentsDetail"), "normal")] : []),
    ...(contents.commands.length ? [ability("commands", translate("tools:pluginAdmin.abilities.commands", { count: contents.commands.length }), translate("tools:pluginAdmin.abilities.commandsDetail"), "normal")] : []),
    ...(contents.hooks.length
      ? [ability("hooks", translate("tools:pluginAdmin.abilities.hooks", { count: contents.hooks.length }), contents.hooks.length > 4 ? translate("tools:pluginAdmin.abilities.hooksDetailMore", { events }) : translate("tools:pluginAdmin.abilities.hooksDetail", { events }), "sensitive")]
      : []),
    ...(contents.mcpServers.length ? [ability("mcp", translate("tools:pluginAdmin.abilities.mcpServers", { count: contents.mcpServers.length }), translate("tools:pluginAdmin.abilities.mcpServersDetail"), "sensitive")] : []),
  ];
}

/** Like an app's permissions, what a plugin can do and what it hooks into, like the desktop's overview. */
export function PluginAbilities({ mod }: { mod: Mod }) {
  const c = useColors();
  const { t } = useTranslation("tools");
  const check = mod.check;
  const source = mod.source;
  // From a repository: what it brings tells more than the validator's notes, which only cover function hooks.
  const abilities = source ? [...contentsAbilities(mod.contents), ...hookAbilities(mod).filter((a) => a.id !== "programs")] : hookAbilities(mod);
  const everyday = abilities.filter((a) => a.level === "normal");
  const sensitive = abilities.filter((a) => a.level === "sensitive");
  const quiet = !check && !source ? t("pluginAdmin.notCheckedReadCode") : abilities.length === 0 ? (source ? t("pluginAdmin.nothingFoundContents") : t("pluginAdmin.nothingHooked")) : null;
  const hooks: { label: string; detail?: string }[] = source
    ? (mod.contents?.hooks ?? []).map((event) => ({ label: event.replace(/([a-z])([A-Z])/g, "$1 $2"), detail: event }))
    : (check?.hooks ?? []).map((h) => ({ label: hookLabel(h), detail: [h.event, h.matcher].filter(Boolean).join(" · ") }));
  const noHooks = source ? t("pluginAdmin.noHooks") : !check ? t("pluginAdmin.hooksUnknown") : t("pluginAdmin.noHooksYet");
  return (
    <>
      {everyday.length || quiet ? (
        <Group title={t("pluginAdmin.whatItCanDo")}>
          {quiet ? <Quiet text={quiet} /> : null}
          {everyday.map((a) => (
            <Line key={a.id} icon="check" title={a.label} detail={a.detail} />
          ))}
        </Group>
      ) : null}
      {sensitive.length ? (
        <Group title={everyday.length ? t("pluginAdmin.reachesOutside") : t("pluginAdmin.whatItCanDo")}>
          {sensitive.map((a) => (
            <Line key={a.id} icon="warning" color={c.warning} title={a.label} detail={a.detail} />
          ))}
        </Group>
      ) : null}
      <Group title={t("pluginAdmin.hooksInto")}>
        {hooks.length ? null : <Quiet text={noHooks} />}
        {hooks.map((h, i) => (
          <Line key={`${h.detail}-${i}`} title={h.label} detail={h.detail} />
        ))}
      </Group>
    </>
  );
}

function Quiet({ text }: { text: string }) {
  return (
    <View style={styles.line}>
      <T variant="subhead" muted style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}

function Line({ icon, color, title, detail }: { icon?: IconName; color?: string; title: string; detail?: string }) {
  const c = useColors();
  return (
    <View style={styles.line}>
      {icon ? <Icon name={icon} size={14} color={color ?? c.textMuted} style={{ marginTop: 3 }} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="callout" style={{ fontWeight: "500" }}>
          {title}
        </T>
        {detail ? (
          <T variant="footnote" muted>
            {detail}
          </T>
        ) : null}
      </View>
    </View>
  );
}

/** The icons a plugin can wear. */
export function PluginIconGrid({ icons, value, onPick }: { icons: readonly ModIcon[]; value: ModIcon; onPick: (icon: ModIcon) => void }) {
  const c = useColors();
  const { t } = useTranslation("tools");
  return (
    <View style={styles.grid}>
      {icons.map((icon) => {
        const on = icon === value;
        return (
          <Pressable
            key={icon}
            accessibilityRole="radio"
            accessibilityLabel={t(pluginIconLabel(icon))}
            accessibilityState={{ checked: on }}
            onPress={() => {
              tap();
              onPick(icon);
            }}
            style={({ pressed }) => [styles.tile, { backgroundColor: on ? c.brandSoft : c.sunken, opacity: pressed ? 0.6 : 1 }]}
          >
            <Icon name={pluginIcon(icon)} size={20} color={on ? c.brandStrong : c.textMuted} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** Names a plugin brings, the first ones until the human asks for all. */
const FIRST = 24;

export function NameList({ title, names, prefix = "" }: { title: string; names: string[]; prefix?: string }) {
  const c = useColors();
  const { t } = useTranslation("tools");
  const [all, setAll] = useState(false);
  if (!names.length) return null;
  const shown = all ? names : names.slice(0, FIRST);
  return (
    <Group title={`${title} · ${names.length}`}>
      <View style={styles.names}>
        {shown.map((name) => (
          <View key={name} style={[styles.name, { backgroundColor: c.sunken }]}>
            <T variant="caption" numberOfLines={1}>
              {prefix}
              {name}
            </T>
          </View>
        ))}
        {names.length > FIRST ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setAll((v) => !v)} style={styles.name}>
            <T variant="caption" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {all ? t("pluginAdmin.contentsView.showFewer") : t("pluginAdmin.contentsView.showAll", { n: names.length })}
            </T>
          </Pressable>
        ) : null}
      </View>
    </Group>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10, minHeight: 44 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, padding: space.md },
  tile: { width: 48, height: 48, borderRadius: radius.md, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  names: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: space.md },
  name: { maxWidth: "100%", paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm, borderCurve: "continuous" },
});
