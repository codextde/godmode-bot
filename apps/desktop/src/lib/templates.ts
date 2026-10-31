import type { AgentTemplate, TeamTemplate } from "@godmode/shared";
import { t } from "@/i18n";

const text = (key: string, fallback: string): string => t(`templates:${key}` as never, { defaultValue: fallback });

export function templateText(tpl: AgentTemplate): AgentTemplate {
  const key = `roles.${tpl.id}`;
  const covers: unknown = t(`templates:${key}.covers` as never, { returnObjects: true, defaultValue: tpl.covers });
  return {
    ...tpl,
    name: text(`${key}.name`, tpl.name),
    role: text(`${key}.role`, tpl.role),
    description: text(`${key}.description`, tpl.description),
    covers: Array.isArray(covers) && covers.length === tpl.covers?.length ? (covers as string[]) : tpl.covers,
    routine: tpl.routine && { ...tpl.routine, name: text(`${key}.routine`, tpl.routine.name) },
  };
}

export const teamText = (team: TeamTemplate): TeamTemplate => ({
  ...team,
  name: text(`teams.${team.id}.name`, team.name),
  description: text(`teams.${team.id}.description`, team.description),
});
