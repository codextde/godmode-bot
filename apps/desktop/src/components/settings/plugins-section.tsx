import { GitBranch, Puzzle, ShieldCheck, Sparkles } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { useEasyMode } from "@/lib/mode";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function PluginsSection({ settings }: { settings: Settings }) {
  const easy = useEasyMode();
  const title = easy ? "Add-ons" : "Plugins";
  return (
    <FeatureSection
      feature="plugins"
      settings={settings}
      title={title}
      summary="Claude Code plugins for your agents: skills, subagents, slash commands, hooks and MCP servers, installed from GitHub or written for you."
      icon={<Puzzle />}
      offNote="Runs load no plugins while it's off. Your plugins and their settings stay as they are."
      points={[
        { icon: <GitBranch />, text: "Install any plugin from a git repository" },
        { icon: <Sparkles />, text: "Small hooks your agents write for you" },
        { icon: <ShieldCheck />, text: "Each one checked, switched off until you allow it" },
      ]}
    >
      <FeaturePageLink to="/plugins" icon={<Puzzle />} title={`Open ${title}`} description="Install, switch on and pick the agents each plugin is for." />
    </FeatureSection>
  );
}
