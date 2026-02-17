#!/usr/bin/env tsx
// ============================================================
// CLI: Scan markets for edges (one-shot, no trading)
// ============================================================

import { loadConfig } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";
import { KalshiClient } from "../api/kalshi-client.js";
import { LLMForecaster } from "../forecaster/llm-forecaster.js";
import { EdgeDetector } from "../agent/edge-detector.js";
import { isLLMForecastable, selectDiverseCandidates } from "../utils/market-filter.js";

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

  // 2. Filter with diagnostic logging
  const open = markets.filter((m) => m.status === "open");
  logger.info(`  Filter: status=open → ${open.length}`);

  const hasPrice = open.filter((m) => m.yesAsk > 0 || m.yesBid > 0);
  logger.info(`  Filter: has price data → ${hasPrice.length}`);

  const hasVolume = hasPrice.filter((m) => m.volume >= 10);
  logger.info(`  Filter: volume >= 10 → ${hasVolume.length}`);

  // Use yesAsk as the price signal; yesBid is often 0 on illiquid markets.
  // Fall back to midpoint only when both sides are populated.
  const priceFiltered = hasVolume.filter((m) => {
    const price = (m.yesBid > 0 && m.yesAsk > 0)
      ? (m.yesAsk + m.yesBid) / 2   // true midpoint when book has both sides
      : (m.yesAsk || m.yesBid);      // use whichever side is available
    return price > 5 && price < 95;
  });
  logger.info(`  Filter: price 5-95¢ → ${priceFiltered.length}`);

  // Skip markets where LLM has no informational edge (weather, 15-min crypto, etc.)
  const forecastable = priceFiltered.filter(isLLMForecastable);
  logger.info(`  Filter: LLM-forecastable → ${forecastable.length} (excluded ${priceFiltered.length - forecastable.length} real-time-dependent)`);

  // Select diverse candidates across categories (not just first N)
  const candidates = selectDiverseCandidates(forecastable, 15);

  // Log the category distribution
  const catCounts = new Map<string, number>();
  for (const m of candidates) {
    const cat = m.category || "other";
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }
  const catSummary = [...catCounts.entries()].map(([k, v]) => `${k}:${v}`).join(", ");
  logger.info(`Forecasting ${candidates.length} candidates (${catSummary})`);

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
    const profits = arbs.filter((a) => a.type === "guaranteed_profit");
    const wide = arbs.filter((a) => a.type === "wide_spread");

    if (profits.length > 0) {
      console.log(`\n  ARBITRAGE OPPORTUNITIES (${profits.length} found):\n`);
      for (const arb of profits.slice(0, 16)) {
        console.log(
          `  💰 ${arb.ticker.padEnd(35)} ` +
            `YES: ${arb.yesAsk}¢ + NO: ${arb.noAsk}¢ = ${arb.total}¢ → ${100 - arb.total}¢ free`
        );
      }
      if (profits.length > 16) console.log(`  ... and ${profits.length - 16} more`);
    }

    if (wide.length > 0) {
      console.log(`\n  WIDE SPREADS (${wide.length} found — informational):\n`);
      for (const arb of wide.slice(0, 10)) {
        console.log(
          `  ⚠️  ${arb.ticker.padEnd(35)} ` +
            `spread: ${arb.total - 100}¢ (YES ask: ${arb.yesAsk}¢, NO ask: ${arb.noAsk}¢)`
        );
      }
      if (wide.length > 10) console.log(`  ... and ${wide.length - 10} more`);
    }
  }

  console.log("\n" + "=".repeat(70) + "\n");
}

main().catch(console.error);
