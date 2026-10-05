import path from "node:path";

const root = path.join(import.meta.dirname, "../..");

/** @type {import("next").NextConfig} */
const nextConfig = {
  // The workspace root, so a lockfile further up the tree can never be mistaken for it.
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
  reactStrictMode: true,
  // `forbidden()` (403 pages for missing permissions) is behind this flag in Next 16.
  experimental: { authInterrupts: true },
  // Development: the dev server is also opened as 127.0.0.1; HMR refuses other origins.
  allowedDevOrigins: ["127.0.0.1"],
  // Paths the custom server (server/main.ts) answers itself never reach Next: /ui, /d, /gw, /relay.
};

export default nextConfig;
