#!/usr/bin/env tsx
// ============================================================
// CLI: Scan markets for edges (one-shot, no trading)
// ============================================================

import { loadConfig } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { KalshiClient } from "../api/kalshi-client.js";
import { LLMForecaster } from "../forecaster/llm-forecaster.js";
import { EdgeDetector } from "../agent/edge-detector.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info("=== Kalshi Market Scanner ===");

  const kalshi = new KalshiClient(config, logger);
  const forecaster = new LLMForecaster(config, logger);
  const edgeDetector = new EdgeDetector(config, logger);

  // 1. Fetch markets
  logger.info("Fetching open markets...");
  const markets = await kalshi.getAllOpenMarkets();
  logger.info(`Found ${markets.length} open markets`);

  // 2. Filter
  const candidates = markets
    .filter((m) => m.status === "open")
    .filter((m) => m.volume >= 10)
    .filter((m) => {
      const mid = (m.yesAsk + m.yesBid) / 2;
      return mid > 5 && mid < 95;
    })
    .slice(0, 15); // Limit LLM calls

  logger.info(`Forecasting ${candidates.length} candidates...`);

  // 3. Forecast
  const forecasts = await forecaster.forecastBatch(candidates, undefined, 1500);

  // 4. Detect edges
  const edges = edgeDetector.detectEdges(candidates, forecasts);

  // 5. Check arbitrage
  const arbs = edgeDetector.findArbitrageOpportunities(markets);

  // 6. Report
  console.log("\n" + "=".repeat(70));
  console.log("  MARKET SCAN RESULTS");
  console.log("=".repeat(70));

  if (edges.length > 0) {
    console.log(`\n  TOP EDGES (${edges.length} found):\n`);
    for (const edge of edges.slice(0, 10)) {
      console.log(
        `  ${edge.side.toUpperCase().padEnd(4)} ${edge.ticker.padEnd(35)} ` +
          `Model: ${(edge.modelProb * 100).toFixed(1)}% | ` +
          `Market: ${(edge.marketProb * 100).toFixed(1)}% | ` +
          `Edge: +${(edge.edge * 100).toFixed(1)}% | ` +
          `EV: ${(edge.expectedValue * 100).toFixed(1)}%`
      );
    }
  } else {
    console.log("\n  No edges found above threshold.");
  }

  if (arbs.length > 0) {
    console.log(`\n  ARBITRAGE ANOMALIES (${arbs.length} found):\n`);
    for (const arb of arbs) {
      console.log(
        `  ${arb.type === "guaranteed_profit" ? "💰" : "⚠️ "} ${arb.ticker.padEnd(35)} ` +
          `YES: ${arb.yesAsk}¢ + NO: ${arb.noAsk}¢ = ${arb.total}¢`
      );
    }
  }

  console.log("\n" + "=".repeat(70) + "\n");
}

main().catch(console.error);
