import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Shell } from "@/components/client/shell";
import { configPathFor } from "@/lib/sy";
import { panelToken } from "@/lib/auth";
import { THEME_BOOT } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "SwitchYard", template: "%s · SwitchYard" },
  description: "Models, routing, tasks, requests and provider keys for SwitchYard Router.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Shell configPath={configPathFor()} loginEnabled={panelToken() !== null}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
