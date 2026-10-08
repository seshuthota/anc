import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // No floating dev-tools badge over the workspace in dev and e2e screenshots.
  devIndicators: false,
  outputFileTracingRoot: join(__dirname, "../.."),
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: ["@anc/policy"],
  serverExternalPackages: ["@ag-ui/client", "@ag-ui/core", "@copilotkit/runtime"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
