import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The router library opens SQLite (native module) and reads config files: never bundle it.
  serverExternalPackages: ["switchyard-router", "better-sqlite3"],
  poweredByHeader: false,
  // Install-wide pages moved under /all when the panel became project-based (lib/links.ts). The
  // per-project pages (/jobs, /tasks/<id>, ...) redirect from app/ pages: they need the store.
  async redirects() {
    return ["models", "routing", "keys", "qualification", "calibration", "settings"].flatMap((p) => [
      { source: `/${p}`, destination: `/all/${p}`, permanent: true },
      { source: `/${p}/:rest*`, destination: `/all/${p}/:rest*`, permanent: true },
    ]);
  },
  devIndicators: false,
  turbopack: {
    // The router library (external at runtime) builds file paths from config values; file tracing
    // cannot follow them and warns. They are expected.
    ignoreIssue: [{ path: "**/packages/router/dist/**", title: /Dynamic filesystem access/ }],
  },
};

export default nextConfig;
