import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { motion } from "motion/react";
import { Boxes, KeyRound, Plug, Server } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageBody, PageHeader } from "@/components/common";
import { ApiKeysTab } from "@/components/integrations/api-keys-tab";
import { ComposioTab, useComposioConnections, useComposioStatus } from "@/components/integrations/composio-tab";
import { McpServersTab, useMcpServers } from "@/components/integrations/mcp-servers-tab";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

const TABS = ["composio", "mcp", "api-keys"] as const;
type Tab = (typeof TABS)[number];

export default function IntegrationsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "composio";
  const setTab = (t: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (t === "composio") next.delete("tab");
        else next.set("tab", t);
        return next;
      },
      { replace: true },
    );

  // Counts for the tab badges (shared caches with the tabs themselves).
  const status = useComposioStatus();
  const composioReady = !!status.data?.configured && status.data.valid !== false;
  const connections = useComposioConnections(composioReady);
  const servers = useMcpServers();
  const secrets = useQuery({ queryKey: qk.appSecrets, queryFn: api.vault.secrets.list });

  const counts: Record<Tab, number | undefined> = {
    composio: connections.data?.filter((c) => c.status.toUpperCase() === "ACTIVE").length,
    mcp: servers.data?.filter((s) => s.source === "custom").length,
    "api-keys": secrets.data?.filter((s) => s.set).length,
  };

  return (
    <div className="relative">
      <PageHeader
        icon={<Plug />}
        title="Integrations"
        description="Give your agents access to apps and tools — Composio for hundreds of SaaS apps, MCP servers for anything else."
      />
      <PageBody>
        <Tabs value={tab} onValueChange={setTab} className="gap-6">
          <TabsList className="h-10 rounded-xl p-1">
            <TabTrigger value="composio" icon={<Boxes />} label="Composio" count={counts.composio} />
            <TabTrigger value="mcp" icon={<Server />} label="MCP servers" count={counts.mcp} />
            <TabTrigger value="api-keys" icon={<KeyRound />} label="API keys" count={counts["api-keys"]} />
          </TabsList>
          <TabsContent value="composio">
            <FadeIn>
              <ComposioTab />
            </FadeIn>
          </TabsContent>
          <TabsContent value="mcp">
            <FadeIn>
              <McpServersTab />
            </FadeIn>
          </TabsContent>
          <TabsContent value="api-keys">
            <FadeIn>
              <ApiKeysTab onOpenComposio={() => setTab("composio")} />
            </FadeIn>
          </TabsContent>
        </Tabs>
      </PageBody>
    </div>
  );
}

function FadeIn({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      {children}
    </motion.div>
  );
}

function TabTrigger({ value, icon, label, count }: { value: Tab; icon: React.ReactNode; label: string; count: number | undefined }) {
  return (
    <TabsTrigger value={value} className="gap-2 rounded-lg px-3.5">
      {icon}
      {label}
      {!!count && (
        <span className="min-w-5 rounded-full bg-primary/15 px-1.5 text-[10px] leading-4 font-semibold text-primary tabular-nums">{count}</span>
      )}
    </TabsTrigger>
  );
}
