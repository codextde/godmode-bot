import type { ComponentType } from "react";
import { COMPOSIO_PREFIXES, SERVICE_LOGOS, SERVICE_NAMES } from "./service-logos.data";

type Logo = ComponentType<{ className?: string }>;

const cache = new Map<string, Logo>();

function logoComponent(id: string): Logo {
  let Logo = cache.get(id);
  if (!Logo) {
    const { viewBox, body } = SERVICE_LOGOS[id]!;
    Logo = ({ className }) => <svg viewBox={viewBox} fill="currentColor" aria-hidden className={className} dangerouslySetInnerHTML={{ __html: body }} />;
    cache.set(id, Logo);
  }
  return Logo;
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mcp[-_.]?|[-_.]?mcp([-_.]?server)?$|[-_.]?server$/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function serviceLogo(server: string, tool: string): Logo | null {
  const byServer = Object.hasOwn(SERVICE_NAMES, normalize(server)) ? SERVICE_NAMES[normalize(server)] : undefined;
  if (byServer) return logoComponent(byServer);
  if (!/^[A-Z0-9_]+$/.test(tool)) return null;
  const lower = tool.toLowerCase();
  const prefix = COMPOSIO_PREFIXES.find((p) => lower.startsWith(`${p}_`));
  return prefix ? logoComponent(SERVICE_NAMES[prefix.replace(/_/g, "")]!) : null;
}
