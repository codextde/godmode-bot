import type { ParseKeys } from "i18next";
import type { McpTransport } from "@godmode/shared";
import type { IconName } from "@/components/icon";

/** The desktop's quick-add MCP servers (Settings → Integrations → MCP servers): one tap fills in the form. */
export interface McpPreset {
  id: string;
  name: string;
  description: ParseKeys<"tools">;
  /** What's left to fill in, shown with the form. */
  note?: ParseKeys<"tools">;
  icon: IconName;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headerKeys?: string[];
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "filesystem",
    name: "filesystem",
    description: "mcpPresets.filesystem.description",
    note: "mcpPresets.filesystem.note",
    icon: "folder",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path/to/folder"],
  },
  {
    id: "github",
    name: "github",
    description: "mcpPresets.github.description",
    note: "mcpPresets.github.note",
    icon: "code",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headerKeys: ["Authorization"],
  },
  {
    id: "playwright",
    name: "playwright",
    description: "mcpPresets.playwright.description",
    icon: "globe",
    transport: "stdio",
    command: "npx",
    args: ["@playwright/mcp@latest"],
  },
  {
    id: "fetch",
    name: "fetch",
    description: "mcpPresets.fetch.description",
    icon: "download",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
  },
  {
    id: "context7",
    name: "context7",
    description: "mcpPresets.context7.description",
    icon: "scrollText",
    transport: "http",
    url: "https://mcp.context7.com/mcp",
  },
];

export const mcpPresetById = (id: string | undefined) => MCP_PRESETS.find((p) => p.id === id);
