import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import type { Agent, AgentInput } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { clearDraft } from "@/lib/drafts";
import { Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { AgentForm } from "../agent-form";
import { DeleteAgentDialog } from "../agent-actions";

export function SettingsTab({ agent }: { agent: Agent }) {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [formKey, setFormKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const draftKey = `agent:${agent.id}`;

  const save = useMutation({
    mutationFn: (input: AgentInput) => withGrant((grant) => api.agents.update(agent.id, input, grant)),
    onSuccess: (updated) => {
      clearDraft(draftKey);
      qc.setQueryData(qk.agent(agent.id), updated);
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.agentFile(agent.id, "CLAUDE.md") });
      // Re-seed the form from the saved agent
      setFormKey((k) => k + 1);
      toast.success(t("settingsTab.saved"), { description: t("settingsTab.savedDescription") });
    },
    onError: (err) => !isGrantCancelled(err) && toast.error(t("settingsTab.saveError"), { description: errorMessage(err) }),
  });

  return (
    <div className="space-y-6">
      <AgentForm
        key={`${agent.id}:${formKey}`}
        mode="edit"
        initial={agent}
        agentId={agent.id}
        draftKey={draftKey}
        isDefault={agent.isDefault}
        submitLabel={t("settingsTab.saveChanges")}
        pending={save.isPending}
        onSubmit={(input) => save.mutate(input)}
      />
      {!agent.isDefault && (
        <Section
          title={t("settingsTab.dangerZone")}
          description={t("settingsTab.dangerZoneDescription")}
          className="border-destructive/30"
        >
          <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> {t("settingsTab.deleteAgent", { name: agent.name })}
          </Button>
        </Section>
      )}
      <DeleteAgentDialog agent={agent} open={confirmDelete} onOpenChange={setConfirmDelete} onDeleted={() => navigate("/agents")} />
    </div>
  );
}
