import type { NextConfig } from "next";

// Files the server reads at runtime by path. Next's file tracing cannot see these, so serverless deployments
// (Vercel) must be told to bundle them with the functions that need them.
const FPL_OFFLINE_SAMPLE = ["./tests/fixtures/bootstrap-static.json", "./tests/fixtures/fixtures.json"];
const BACKTEST_DOCS = ["./docs/backtest/balanced-plus-backtest-results.json", "./docs/backtest-results.json"];
const PDF_ASSETS = [
  "./node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf",
  "./node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf",
  "./node_modules/dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf",
  "./node_modules/pdfkit/js/data/**",
];

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  // pdfkit reads its own font metrics from disk, so it must not be bundled.
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/": FPL_OFFLINE_SAMPLE,
    "/api/**/*": FPL_OFFLINE_SAMPLE,
    "/api/report": [...PDF_ASSETS, ...BACKTEST_DOCS],
    "/api/strategies/balanced-plus": BACKTEST_DOCS,
    "/api/strategies/balanced-plus/report": [...PDF_ASSETS, ...BACKTEST_DOCS],
    "/api/backtest": ["./docs/backtest-results.json"],
    "/api/openapi": ["./docs/openapi.yaml"],
  },
};

export default nextConfig;
