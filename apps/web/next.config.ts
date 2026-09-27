import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
