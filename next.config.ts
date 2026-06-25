import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Proxy API calls to the backend (same pattern as wt-frontend) so the form
  // can POST /api/orders and read /api/regions without CORS.
  async rewrites() {
    const b = process.env.BACKEND_URL ?? "http://localhost:3004";
    return [{ source: "/api/:path*", destination: `${b}/api/:path*` }];
  },
};

export default nextConfig;
