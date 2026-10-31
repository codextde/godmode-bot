import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { motion } from "motion/react";
import { Boxes, Server, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiToolsTab, useApiTools } from "@/components/integrations/api-tools-tab";
import { ComposioTab, useComposioConnections, useComposioStatus } from "@/components/integrations/composio-tab";
import { McpServersTab, useMcpServers } from "@/components/integrations/mcp-servers-tab";
import { NoConnectorsNote } from "@/components/integrations/no-connectors-note";
import { useReduceAnimations } from "@/lib/motion";

const TABS = ["composio", "tools", "mcp"] as const;
type Tab = (typeof TABS)[number];

/** Composio apps, API tools and MCP servers, a tab each (`?tab=`). */
export function IntegrationsOverview() {
  const { t } = useTranslation("integrations");
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
  const tools = useApiTools();

  const counts: Record<Tab, number | undefined> = {
    composio: connections.data?.filter((c) => c.status.toUpperCase() === "ACTIVE").length,
    tools: tools.data?.length,
    mcp: servers.data?.filter((s) => s.source === "custom").length,
  };

  return (
    <div className="@container">
      <NoConnectorsNote />
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList className="h-10 p-1">
          <TabTrigger value="composio" icon={<Boxes />} label="Composio" count={counts.composio} />
          <TabTrigger value="tools" icon={<Wrench />} label={t("tabs.tools")} count={counts.tools} />
          <TabTrigger value="mcp" icon={<Server />} label={t("tabs.mcp")} count={counts.mcp} />
        </TabsList>
        <TabsContent value="composio">
          <FadeIn>
            <ComposioTab />
          </FadeIn>
        </TabsContent>
        <TabsContent value="tools">
          <FadeIn>
            <ApiToolsTab />
          </FadeIn>
        </TabsContent>
        <TabsContent value="mcp">
          <FadeIn>
            <McpServersTab />
          </FadeIn>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FadeIn({ children }: { children: ReactNode }) {
  const reduce = useReduceAnimations();
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      {children}
    </motion.div>
  );
}

function TabTrigger({ value, icon, label, count }: { value: Tab; icon: ReactNode; label: string; count: number | undefined }) {
  return (
    <TabsTrigger value={value} className="gap-2 rounded-md px-3.5">
      {icon}
      {label}
      {!!count && (
        <span className="min-w-5 rounded-[5px] bg-foreground/[0.07] px-1.5 font-mono text-[10.5px] leading-4 text-foreground/70 tabular-nums">{count}</span>
      )}
    </TabsTrigger>
  );
}
