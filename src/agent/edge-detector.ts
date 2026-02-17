// ============================================================
// Edge Detector — Compares forecasts to market prices
// ============================================================

import type { KalshiMarket, Forecast, Edge, AgentConfig } from "../types/index.js";
import type { Logger } from "../utils/logger.js";

export class EdgeDetector {
  private minEdge: number;
  private logger: Logger;

  constructor(config: AgentConfig, logger: Logger) {
    this.minEdge = config.trading.minEdgeThreshold;
    this.logger = logger;
  }

  /**
   * Detect edges where our model disagrees with the market price.
   * Returns only edges that exceed the minimum threshold.
   */
  detectEdges(markets: KalshiMarket[], forecasts: Forecast[]): Edge[] {
    const forecastMap = new Map(forecasts.map((f) => [f.ticker, f]));
    const edges: Edge[] = [];

    for (const market of markets) {
      const forecast = forecastMap.get(market.ticker);
      if (!forecast) continue;

      // Market-implied probability for YES (use midpoint of bid/ask)
      const marketProbYes = this.getImpliedProb(market, "yes");
      const marketProbNo = this.getImpliedProb(market, "no");

      // Check YES side edge
      const yesEdge = forecast.modelProbYes - marketProbYes;
      if (yesEdge > this.minEdge) {
        edges.push(this.buildEdge(market, forecast, "yes", marketProbYes, forecast.modelProbYes, yesEdge));
      }

      // Check NO side edge
      const modelProbNo = 1 - forecast.modelProbYes;
      const noEdge = modelProbNo - marketProbNo;
      if (noEdge > this.minEdge) {
        edges.push(this.buildEdge(market, forecast, "no", marketProbNo, modelProbNo, noEdge));
      }
    }

    // Sort by edge magnitude (highest first)
    edges.sort((a, b) => b.edge - a.edge);

    this.logger.info(`Found ${edges.length} edges above ${(this.minEdge * 100).toFixed(1)}% threshold`);
    for (const edge of edges.slice(0, 10)) {
      this.logger.info(
        `  ${edge.side.toUpperCase()} ${edge.ticker}: ` +
        `model=${(edge.modelProb * 100).toFixed(1)}% vs market=${(edge.marketProb * 100).toFixed(1)}% → ` +
        `edge=${(edge.edge * 100).toFixed(1)}%, EV=${(edge.expectedValue * 100).toFixed(1)}%`
      );
    }

    return edges;
  }

  /**
   * Arbitrage check: find markets where buying both YES + NO
   * costs less than the $1 payout (guaranteed profit), and flag
   * markets with unusually wide bid-ask spreads.
   *
   * In binary markets, no_ask ≈ 100 - yes_bid, so
   * yes_ask + no_ask ≈ 100 + spread. Values > 100 are normal.
   * Only yes_ask + no_ask < 100 represents a true arbitrage.
   */
  findArbitrageOpportunities(markets: KalshiMarket[]): Array<{
    ticker: string;
    title: string;
    yesAsk: number;
    noAsk: number;
    total: number;
    type: "guaranteed_profit" | "wide_spread";
  }> {
    const opps: Array<{
      ticker: string;
      title: string;
      yesAsk: number;
      noAsk: number;
      total: number;
      type: "guaranteed_profit" | "wide_spread";
    }> = [];

    for (const m of markets) {
      if (m.yesAsk === 0 || m.noAsk === 0) continue;
      const total = m.yesAsk + m.noAsk;

      // True arbitrage: buy both sides for < $1 total, guaranteed $1 payout.
      // Use < 98 to account for Kalshi's ~1-2¢ fees per side.
      if (total < 98) {
        opps.push({
          ticker: m.ticker,
          title: m.title,
          yesAsk: m.yesAsk,
          noAsk: m.noAsk,
          total,
          type: "guaranteed_profit",
        });
      }

      // Wide spread: only flag if both sides have real liquidity
      // (skip one-sided books where ask = 99 or 100) and spread > 15¢.
      if (total > 115 && m.yesAsk < 95 && m.noAsk < 95) {
        opps.push({
          ticker: m.ticker,
          title: m.title,
          yesAsk: m.yesAsk,
          noAsk: m.noAsk,
          total,
          type: "wide_spread",
        });
      }
    }

    // Sort: guaranteed profits first (lowest total), then widest spreads
    opps.sort((a, b) => {
      if (a.type !== b.type) return a.type === "guaranteed_profit" ? -1 : 1;
      return a.type === "guaranteed_profit" ? a.total - b.total : b.total - a.total;
    });

    if (opps.length > 0) {
      const profits = opps.filter((o) => o.type === "guaranteed_profit").length;
      const wide = opps.filter((o) => o.type === "wide_spread").length;
      this.logger.info(`Found ${profits} arbitrage opportunities, ${wide} wide spreads`);
    }

    return opps;
  }

  // --- Helpers ---

  private getImpliedProb(market: KalshiMarket, side: "yes" | "no"): number {
    if (side === "yes") {
      // Use midpoint; if no bid, use ask; if no ask, use bid
      if (market.yesBid > 0 && market.yesAsk > 0) {
        return ((market.yesBid + market.yesAsk) / 2) / 100;
      }
      return (market.yesAsk || market.yesBid || 50) / 100;
    } else {
      if (market.noBid > 0 && market.noAsk > 0) {
        return ((market.noBid + market.noAsk) / 2) / 100;
      }
      return (market.noAsk || market.noBid || 50) / 100;
    }
  }

  private buildEdge(
    market: KalshiMarket,
    forecast: Forecast,
    side: "yes" | "no",
    marketProb: number,
    modelProb: number,
    edge: number
  ): Edge {
    // EV = (modelProb × payout) - cost
    // For a $1 contract: cost = marketProb, payout if correct = 1
    // EV per dollar risked = (modelProb / marketProb) - 1
    const cost = marketProb;
    const ev = cost > 0 ? (modelProb * 1) / cost - 1 : 0;

    return {
      ticker: market.ticker,
      market,
      forecast,
      side,
      marketProb,
      modelProb,
      edge,
      expectedValue: ev,
    };
  }
}
