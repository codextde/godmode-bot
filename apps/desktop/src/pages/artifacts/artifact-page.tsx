import { useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, ArrowUp, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ArtifactView, useArtifactActions, useArtifactBusy } from "@/components/artifacts/artifact-view";
import { useArtifact } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** One artifact on the whole screen, with a line to ask its agent for changes. */
export default function ArtifactPage() {
  const { artifactId = "" } = useParams();
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b bg-paper-2 px-2">
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
          <Link to="/settings/artifacts">
            <ArrowLeft /> Artifacts
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <ArtifactView id={artifactId} variant="page" onClose={() => navigate("/settings/artifacts")} footer={<ChangeBar id={artifactId} />} />
      </div>
    </div>
  );
}

function ChangeBar({ id }: { id: string }) {
  const { data: artifact } = useArtifact(id);
  const { message } = useArtifactActions(artifact);
  const busy = useArtifactBusy(artifact);
  const [text, setText] = useState("");
  if (!artifact) return null;
  const agent = artifact.agentName ?? "the agent";
  const send = () => {
    const content = text.trim();
    if (!content || message.isPending) return;
    message.mutate(content, { onSuccess: () => setText("") });
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div className="shrink-0 border-t bg-paper-2 px-3 py-2.5">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-xl border bg-card py-1 pr-1 pl-3 shadow-card transition focus-within:border-foreground/20",
            busy && "border-brand/30",
          )}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={busy ? `${agent} is working on it — you can add more` : `Ask ${agent} to change something…`}
            aria-label="Ask for a change"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button size="icon-sm" className="rounded-lg" onClick={send} disabled={!text.trim() || message.isPending} aria-label="Send">
            {message.isPending ? <Spinner /> : <ArrowUp />}
          </Button>
        </div>
        {artifact.conversationId && (
          <Button asChild variant="ghost" size="sm" className="shrink-0 gap-1.5 text-muted-foreground">
            <Link to={`/chat/${artifact.conversationId}`}>
              <MessageSquareText /> Chat
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
