// ============================================================
// Paper Trader — Simulated execution for testing
// ============================================================

import { randomUUID } from "node:crypto";
import type { TradeSignal, TradeRecord, Portfolio, Position } from "../types/index.js";
import type { Logger } from "../utils/logger.js";

export class PaperTrader {
  private trades: TradeRecord[] = [];
  private positions: Map<string, Position> = new Map();
  private balance: number;
  private initialBalance: number;
  private logger: Logger;

  constructor(initialBalanceUsd: number, logger: Logger) {
    this.balance = initialBalanceUsd;
    this.initialBalance = initialBalanceUsd;
    this.logger = logger;
    this.logger.info(`Paper trader initialized with $${initialBalanceUsd} balance`);
  }

  /** Execute a trade signal in paper mode */
  execute(signal: TradeSignal): TradeRecord {
    const cost = (signal.contracts * signal.limitPrice) / 100;

    if (cost > this.balance) {
      this.logger.warn(`Insufficient balance for ${signal.edge.ticker}: need $${cost.toFixed(2)}, have $${this.balance.toFixed(2)}`);
      return {
        id: randomUUID(),
        signal,
        executedAt: new Date(),
        filled: false,
        mode: "paper",
      };
    }

    // Deduct cost
    this.balance -= cost;

    // Add/update position
    const existing = this.positions.get(signal.edge.ticker);
    if (existing && existing.side === signal.side) {
      // Average in
      const totalContracts = existing.contracts + signal.contracts;
      existing.avgPrice =
        (existing.avgPrice * existing.contracts + signal.limitPrice * signal.contracts) / totalContracts;
      existing.contracts = totalContracts;
    } else {
      this.positions.set(signal.edge.ticker, {
        ticker: signal.edge.ticker,
        side: signal.side,
        contracts: signal.contracts,
        avgPrice: signal.limitPrice,
        currentPrice: signal.limitPrice,
        marketTitle: signal.edge.market.title,
      });
    }

    const record: TradeRecord = {
      id: randomUUID(),
      signal,
      executedAt: new Date(),
      fillPrice: signal.limitPrice,
      filled: true,
      mode: "paper",
    };

    this.trades.push(record);
    this.logger.info(
      `[PAPER] Executed: BUY ${signal.contracts}x ${signal.side.toUpperCase()} ${signal.edge.ticker} @ ${signal.limitPrice}¢ ($${cost.toFixed(2)})`
    );

    return record;
  }

  /** Settle a market (call when market resolves) */
  settle(ticker: string, result: "yes" | "no"): number {
    const position = this.positions.get(ticker);
    if (!position) return 0;

    let pnl: number;
    if (position.side === result) {
      // Won: receive $1 per contract, subtract cost
      const revenue = position.contracts; // $1 per contract
      const cost = (position.contracts * position.avgPrice) / 100;
      pnl = revenue - cost;
    } else {
      // Lost: lose entire cost
      pnl = -(position.contracts * position.avgPrice) / 100;
    }

    this.balance += (position.contracts * (position.side === result ? 100 : 0)) / 100;
    this.positions.delete(ticker);

    this.logger.info(
      `[PAPER] Settled ${ticker}: ${result.toUpperCase()} → P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`
    );

    return pnl;
  }

  /** Get current portfolio state */
  getPortfolio(): Portfolio {
    const positions = Array.from(this.positions.values());
    const totalExposure = positions.reduce(
      (sum, p) => sum + (p.contracts * p.avgPrice) / 100,
      0
    );
    const realizedPnl = this.balance - this.initialBalance + totalExposure;

    return {
      balanceUsd: this.balance,
      positions,
      totalExposureUsd: totalExposure,
      realizedPnl,
      unrealizedPnl: 0, // Would need live prices to calculate
    };
  }

  /** Get all trade records */
  getTrades(): TradeRecord[] {
    return [...this.trades];
  }

  /** Print a summary report */
  printSummary(): void {
    const portfolio = this.getPortfolio();
    const totalTrades = this.trades.length;
    const filledTrades = this.trades.filter((t) => t.filled).length;

    console.log("\n" + "=".repeat(60));
    console.log("  PAPER TRADING SUMMARY");
    console.log("=".repeat(60));
    console.log(`  Initial Balance:   $${this.initialBalance.toFixed(2)}`);
    console.log(`  Current Balance:   $${portfolio.balanceUsd.toFixed(2)}`);
    console.log(`  Open Positions:    ${portfolio.positions.length}`);
    console.log(`  Total Exposure:    $${portfolio.totalExposureUsd.toFixed(2)}`);
    console.log(`  Total Trades:      ${totalTrades} (${filledTrades} filled)`);
    console.log(`  Realized P&L:      ${portfolio.realizedPnl >= 0 ? "+" : ""}$${portfolio.realizedPnl.toFixed(2)}`);
    console.log("=".repeat(60));

    if (portfolio.positions.length > 0) {
      console.log("\n  OPEN POSITIONS:");
      for (const pos of portfolio.positions) {
        console.log(
          `  ${pos.side.toUpperCase().padEnd(4)} ${pos.contracts}x ${pos.ticker.padEnd(30)} @ ${pos.avgPrice}¢ — ${pos.marketTitle}`
        );
      }
    }
    console.log("");
  }
}
