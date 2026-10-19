import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The router library opens SQLite (native module) and reads config files: never bundle it.
  serverExternalPackages: ["switchyard-router", "better-sqlite3"],
  poweredByHeader: false,
  devIndicators: false,
  turbopack: {
    // The router library (external at runtime) builds file paths from config values; file tracing
    // cannot follow them and warns. They are expected.
    ignoreIssue: [{ path: "**/packages/router/dist/**", title: /Dynamic filesystem access/ }],
  },
};

export default nextConfig;
