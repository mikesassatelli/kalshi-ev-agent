#!/usr/bin/env tsx
// ============================================================
// CLI: Run the agent in paper trading mode
// ============================================================

import { loadConfig } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { TradingAgent } from "../agent/trading-agent.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Kalshi EV Agent — Paper Trading Mode              ║
╠══════════════════════════════════════════════════════════════╣
║  Environment:  ${config.kalshi.environment.toUpperCase().padEnd(43)}║
║  Min Edge:     ${(config.trading.minEdgeThreshold * 100).toFixed(1)}%${" ".repeat(40)}║
║  Kelly:        ${(config.trading.kellyFraction * 100).toFixed(0)}% (fractional)${" ".repeat(30)}║
║  Max Position: $${config.trading.maxPositionUsd.toFixed(0).padEnd(42)}║
║  Categories:   ${config.trading.marketCategories.join(", ").padEnd(43)}║
║  Scan every:   ${config.trading.scanIntervalSeconds}s${" ".repeat(41)}║
╚══════════════════════════════════════════════════════════════╝
  `);

  const agent = new TradingAgent(config, logger, "paper");

  // Graceful shutdown
  process.on("SIGINT", () => {
    logger.info("Received SIGINT, shutting down...");
    agent.stop();
  });
  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM, shutting down...");
    agent.stop();
  });

  // Run single cycle for testing, or continuous loop
  const singleCycle = process.argv.includes("--once");
  if (singleCycle) {
    await agent.runCycle();
  } else {
    await agent.start();
  }
}

main().catch(console.error);
