import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./globals.css";
import { Shell } from "@/components/client/shell";
import type { SwitcherProject } from "@/components/client/project-switcher";
import { configPathFor, getSy } from "@/lib/sy";
import { switcherProjects } from "@/lib/project";
import { panelToken, safeEqual, sessionValue, SESSION_COOKIE } from "@/lib/auth";
import { THEME_BOOT } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "SwitchYard", template: "%s · SwitchYard" },
  description: "Projects, jobs, tasks, models, routing, requests and provider keys for SwitchYard Router.",
};

export const dynamic = "force-dynamic";

/** The switcher's first list (it refreshes from /api/projects when it opens); none before sign-in. */
async function initialProjects(): Promise<SwitcherProject[]> {
  const token = panelToken();
  // The layout also renders the sign-in page: never put project names in front of a signed-out visitor.
  if (token && !safeEqual((await cookies()).get(SESSION_COOKIE)?.value ?? "", await sessionValue(token))) return [];
  const r = getSy();
  if (!r.sy) return [];
  try {
    return switcherProjects(r.sy);
  } catch (err) {
    console.error("[panel] listing projects failed:", err);
    return [];
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const projects = await initialProjects();
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Shell configPath={configPathFor()} loginEnabled={panelToken() !== null} projects={projects}>
          {children}
        </Shell>
      </body>
    </html>
  );
}
