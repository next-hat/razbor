import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
  // Runtime Markdown reads must remain available in the standalone server.
  outputFileTracingIncludes: {
    "/*": [
      "../../packages/harness/src/prompts/**/*.md",
      "../../packages/database/src/defaults/*.md",
    ],
  },
  experimental: {
    cpus: 2,
    // Webpack preserves the Node ESM .js imports used by the TypeScript workspaces.
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
  // Preserve the external host and protocol in login and password-change redirects.
  skipProxyUrlNormalize: true,
  serverExternalPackages: ["pg-boss", "pino", "pino-pretty"],
  // Authorization codes and state arrive in callback queries; keep them out of dev access logs.
  logging: {
    incomingRequests: { ignore: [/^\/api\/auth\/oidc\/callback(?:\?|$)/] },
  },
  /**
   * Keeps the original HTTP API paths working through the corresponding Next.js route
   * handlers.
   */
  async rewrites() {
    return [
      { source: "/health", destination: "/api/health" },
      { source: "/review", destination: "/api/review" },
      { source: "/reviews", destination: "/api/reviews" },
      { source: "/reviews/:id", destination: "/api/reviews/:id" },
      { source: "/repositories", destination: "/api/repositories" },
      { source: "/repositories/:id", destination: "/api/repositories/:id" },
    ];
  },
};

export default config;
