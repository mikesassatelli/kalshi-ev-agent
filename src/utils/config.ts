import "dotenv/config";
import type { AgentConfig } from "../types/index.js";

export function loadConfig(): AgentConfig {
  const env = process.env.KALSHI_ENV ?? "demo";

  const basePath =
    env === "prod"
      ? "https://api.elections.kalshi.com/trade-api/v2"
      : "https://demo-api.kalshi.co/trade-api/v2";

  return {
    kalshi: {
      apiKeyId: requireEnv("KALSHI_API_KEY_ID"),
      privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
      privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM,
      environment: env as "prod" | "demo",
      basePath,
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    },
    trading: {
      minEdgeThreshold: parseFloat(process.env.MIN_EDGE_THRESHOLD ?? "0.05"),
      kellyFraction: parseFloat(process.env.KELLY_FRACTION ?? "0.25"),
      maxPositionUsd: parseFloat(process.env.MAX_POSITION_USD ?? "50"),
      maxPortfolioExposureUsd: parseFloat(process.env.MAX_PORTFOLIO_EXPOSURE_USD ?? "500"),
      scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS ?? "300", 10),
      marketCategories: (process.env.MARKET_CATEGORIES ?? "politics,economics,crypto")
        .split(",")
        .map((s) => s.trim()),
    },
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}
