import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { DEFAULT_APP_NAME } from "@/components/brand";
import { Providers } from "@/components/providers";
import { getSettings } from "@/server/settings";
import "./globals.css";

// Every page renders per request: the CSP nonce changes each time (amendment A.1).
export const dynamic = "force-dynamic";

/** general.appName, read per request (never at build time). A database hiccup must not take every page down. */
async function appName(): Promise<string> {
  try {
    const general = await getSettings("general");
    return general.appName.trim() || DEFAULT_APP_NAME;
  } catch {
    return DEFAULT_APP_NAME;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const name = await appName();
  return {
    title: { template: `%s · ${name}`, default: name },
    description: "Open your Godmode from any browser and manage people, computers and billing.",
    applicationName: name,
    appleWebApp: { title: name, statusBarStyle: "default" },
    formatDetection: { telephone: false, email: false, address: false },
    // A private, self-hosted service: nothing here belongs in a search index.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Paper; public/theme-init.js and the ThemeProvider switch it to anthracite in dark mode.
  themeColor: "#faf9f5",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // theme-init.js sets class, data-theme and color-scheme on <html> before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script src="/theme-init.js" nonce={nonce} suppressHydrationWarning />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
