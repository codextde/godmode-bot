import { KeyRound, Server, SquareTerminal, Upload } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { useEasyMode } from "@/lib/mode";
import { FeaturePageLink, FeatureSection } from "./feature-section";

export function SshSection({ settings }: { settings: Settings }) {
  const easy = useEasyMode();
  const title = easy ? "Servers" : "SSH servers";
  return (
    <FeatureSection
      feature="ssh"
      settings={settings}
      title={title}
      summary="Remote machines agents sign in to: they run commands, edit files and copy files back and forth."
      icon={<Server />}
      points={[
        { icon: <SquareTerminal />, text: "Commands and file edits on Linux and macOS servers" },
        { icon: <KeyRound />, text: "Godmode types the password or key and answers sudo" },
        { icon: <Upload />, text: "Uploads and downloads within the run's folders" },
      ]}
    >
      <FeaturePageLink to="/ssh" icon={<Server />} title={`Open ${title}`} description="Add servers and pick the agents that may use them." />
    </FeatureSection>
  );
}
