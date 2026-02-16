// ============================================================
// Risk Manager — Position sizing and risk controls
// ============================================================

import type { Edge, TradeSignal, Portfolio, AgentConfig } from "../types/index.js";
import type { Logger } from "../utils/logger.js";

export class RiskManager {
  private kellyFraction: number;
  private maxPositionUsd: number;
  private maxExposureUsd: number;
  private logger: Logger;

  // Circuit breaker state
  private dailyLoss = 0;
  private dailyLossLimit: number;
  private tradesThisHour = 0;
  private maxTradesPerHour = 20;
  private lastHourReset = Date.now();

  constructor(config: AgentConfig, logger: Logger) {
    this.kellyFraction = config.trading.kellyFraction;
    this.maxPositionUsd = config.trading.maxPositionUsd;
    this.maxExposureUsd = config.trading.maxPortfolioExposureUsd;
    this.dailyLossLimit = config.trading.maxPortfolioExposureUsd * 0.1; // 10% of max exposure
    this.logger = logger;
  }

  /**
   * Convert edges into sized trade signals, applying all risk controls.
   */
  generateSignals(edges: Edge[], portfolio: Portfolio): TradeSignal[] {
    this.resetHourlyCounterIfNeeded();

    // Circuit breaker checks
    if (this.dailyLoss >= this.dailyLossLimit) {
      this.logger.warn(`Circuit breaker: daily loss limit hit ($${this.dailyLoss.toFixed(2)})`);
      return [];
    }

    const signals: TradeSignal[] = [];
    let remainingExposure = this.maxExposureUsd - portfolio.totalExposureUsd;

    for (const edge of edges) {
      if (this.tradesThisHour >= this.maxTradesPerHour) {
        this.logger.warn("Circuit breaker: hourly trade limit reached");
        break;
      }

      if (remainingExposure <= 0) {
        this.logger.warn("Max portfolio exposure reached, skipping remaining edges");
        break;
      }

      // Skip low-confidence forecasts
      if (edge.forecast.confidence < 0.3) {
        this.logger.debug(`Skipping ${edge.ticker}: low confidence (${edge.forecast.confidence})`);
        continue;
      }

      // Check if we already have a position in this market
      const existingPosition = portfolio.positions.find((p) => p.ticker === edge.ticker);
      if (existingPosition) {
        this.logger.debug(`Skipping ${edge.ticker}: already have a position`);
        continue;
      }

      const signal = this.sizePosition(edge, portfolio.balanceUsd, remainingExposure);
      if (signal) {
        signals.push(signal);
        remainingExposure -= signal.positionSizeUsd;
        this.tradesThisHour++;
      }
    }

    this.logger.info(`Generated ${signals.length} trade signals from ${edges.length} edges`);
    return signals;
  }

  /**
   * Kelly Criterion position sizing.
   *
   * Kelly fraction = (p × b - q) / b
   * Where:
   *   p = model probability of winning
   *   q = 1 - p
   *   b = odds (payout / cost - 1, i.e., net odds received)
   *
   * We then apply a fractional Kelly (e.g., ¼ Kelly) for safety.
   */
  private sizePosition(
    edge: Edge,
    bankroll: number,
    remainingExposure: number
  ): TradeSignal | null {
    const p = edge.modelProb;
    const q = 1 - p;
    const cost = edge.marketProb; // cost per contract as fraction of $1
    const payout = 1; // $1 payout on correct prediction

    // Net odds: what you win relative to what you risk
    const b = (payout - cost) / cost; // e.g., buy at 40¢ → win 60¢ on 40¢ risk → b = 1.5

    if (b <= 0) return null;

    // Full Kelly fraction
    const fullKelly = (p * b - q) / b;

    if (fullKelly <= 0) {
      this.logger.debug(`Negative Kelly for ${edge.ticker}, skipping`);
      return null;
    }

    // Apply fractional Kelly
    const adjustedKelly = fullKelly * this.kellyFraction;

    // Convert to dollar amount
    let positionSizeUsd = bankroll * adjustedKelly;

    // Apply hard caps
    positionSizeUsd = Math.min(positionSizeUsd, this.maxPositionUsd);
    positionSizeUsd = Math.min(positionSizeUsd, remainingExposure);
    positionSizeUsd = Math.max(positionSizeUsd, 1); // minimum $1

    // Calculate number of contracts (each contract costs yesPrice or noPrice cents)
    const pricePerContract =
      edge.side === "yes" ? edge.market.yesAsk : edge.market.noAsk;

    if (pricePerContract <= 0) return null;

    const contracts = Math.floor((positionSizeUsd * 100) / pricePerContract);
    if (contracts <= 0) return null;

    const actualPositionUsd = (contracts * pricePerContract) / 100;

    const signal: TradeSignal = {
      edge,
      side: edge.side,
      action: "buy",
      contracts,
      limitPrice: pricePerContract,
      kellyFraction: adjustedKelly,
      positionSizeUsd: actualPositionUsd,
      reason:
        `Edge: ${(edge.edge * 100).toFixed(1)}% | ` +
        `Model: ${(edge.modelProb * 100).toFixed(1)}% vs Market: ${(edge.marketProb * 100).toFixed(1)}% | ` +
        `Kelly: ${(adjustedKelly * 100).toFixed(2)}% | ` +
        `${contracts} contracts @ ${pricePerContract}¢ = $${actualPositionUsd.toFixed(2)}`,
    };

    this.logger.info(`Signal: BUY ${contracts}x ${edge.side.toUpperCase()} ${edge.ticker} @ ${pricePerContract}¢ ($${actualPositionUsd.toFixed(2)})`);

    return signal;
  }

  /** Record a realized loss for circuit breaker tracking */
  recordLoss(amount: number): void {
    this.dailyLoss += amount;
    if (this.dailyLoss >= this.dailyLossLimit * 0.8) {
      this.logger.warn(`Approaching daily loss limit: $${this.dailyLoss.toFixed(2)} / $${this.dailyLossLimit.toFixed(2)}`);
    }
  }

  /** Reset daily loss counter (call at midnight) */
  resetDaily(): void {
    this.dailyLoss = 0;
    this.logger.info("Daily loss counter reset");
  }

  private resetHourlyCounterIfNeeded(): void {
    if (Date.now() - this.lastHourReset > 3600_000) {
      this.tradesThisHour = 0;
      this.lastHourReset = Date.now();
    }
  }
}
