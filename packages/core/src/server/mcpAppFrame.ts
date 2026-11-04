import type { Context } from "hono";
import type { McpAppCsp } from "@godmode/shared";
import { cleanCsp } from "../integrations/mcpApps";
import { FRAME_HTML } from "./artifactFrame";

const list = (domains: string[] | undefined, fallback: string) => (domains?.length ? domains.join(" ") : fallback);

export function mcpAppFramePolicy(csp: McpAppCsp | null): string {
  const resources = list(csp?.resourceDomains, "");
  return [
    "sandbox allow-scripts allow-forms",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: data: ${resources}`.trim(),
    `style-src 'unsafe-inline' data: ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(csp?.connectDomains, "'none'")}`,
    `frame-src ${list(csp?.frameDomains, "'none'")}`,
    `base-uri ${list(csp?.baseUriDomains, "'none'")}`,
    "worker-src blob:",
    "form-action 'none'",
  ].join("; ");
}

function parseCsp(raw: string | undefined): McpAppCsp | null {
  if (!raw) return null;
  try {
    return cleanCsp(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serveMcpAppFrame(c: Context) {
  return c.body(FRAME_HTML, 200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": mcpAppFramePolicy(parseCsp(c.req.query("csp"))),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}
