// ============================================================
// Trading Agent — Main orchestration loop
// ============================================================

import type { AgentConfig, TradeSignal } from "../types/index.js";
import { KalshiClient } from "../api/kalshi-client.js";
import { LLMForecaster } from "../forecaster/llm-forecaster.js";
import { EdgeDetector } from "./edge-detector.js";
import { RiskManager } from "../risk/risk-manager.js";
import { PaperTrader } from "./paper-trader.js";
import { isLLMForecastable, hasTightSpread, selectDiverseCandidates } from "../utils/market-filter.js";
import type { Logger } from "../utils/logger.js";

export type ExecutionMode = "paper" | "live";

export class TradingAgent {
  private kalshi: KalshiClient;
  private forecaster: LLMForecaster;
  private edgeDetector: EdgeDetector;
  private riskManager: RiskManager;
  private paperTrader: PaperTrader;
  private config: AgentConfig;
  private logger: Logger;
  private mode: ExecutionMode;
  private running = false;

  constructor(config: AgentConfig, logger: Logger, mode: ExecutionMode = "paper") {
    this.config = config;
    this.logger = logger;
    this.mode = mode;

    this.kalshi = new KalshiClient(config, logger);
    this.forecaster = new LLMForecaster(config, logger);
    this.edgeDetector = new EdgeDetector(config, logger);
    this.riskManager = new RiskManager(config, logger);
    this.paperTrader = new PaperTrader(1000, logger); // $1000 paper balance

    this.logger.info(`Trading agent initialized in ${mode.toUpperCase()} mode`);
  }

  /** Run a single scan cycle */
  async runCycle(): Promise<void> {
    this.logger.info("--- Starting scan cycle ---");

    try {
      // 1. Fetch all open markets
      const markets = await this.kalshi.getAllOpenMarkets();
      this.logger.info(`Fetched ${markets.length} open markets`);

      // 2. Filter to interesting markets
      const filtered = this.filterMarkets(markets);
      this.logger.info(`Filtered to ${filtered.length} candidate markets`);

      if (filtered.length === 0) {
        this.logger.info("No candidate markets found, skipping cycle");
        return;
      }

      // 3. Check for arbitrage opportunities (fast, no LLM needed)
      const arbOpps = this.edgeDetector.findArbitrageOpportunities(markets);
      if (arbOpps.length > 0) {
        for (const opp of arbOpps) {
          this.logger.info(`ARB: ${opp.ticker} — YES ${opp.yesAsk}¢ + NO ${opp.noAsk}¢ = ${opp.total}¢ (${opp.type})`);
        }
      }

      // 4. Forecast probabilities (LLM calls — this is the expensive part)
      // Skip markets the LLM can't forecast well and illiquid markets,
      // then pick diverse candidates across event groups
      const forecastable = filtered.filter((m) => isLLMForecastable(m) && hasTightSpread(m));
      const topCandidates = selectDiverseCandidates(forecastable, 10);
      const forecasts = await this.forecaster.forecastBatch(topCandidates);

      // 5. Detect edges
      const edges = this.edgeDetector.detectEdges(topCandidates, forecasts);

      if (edges.length === 0) {
        this.logger.info("No edges found above threshold");
        return;
      }

      // 6. Generate sized trade signals
      const portfolio =
        this.mode === "paper"
          ? this.paperTrader.getPortfolio()
          : {
              balanceUsd: await this.kalshi.getBalance(),
              positions: [],
              totalExposureUsd: 0,
              realizedPnl: 0,
              unrealizedPnl: 0,
            };

      const signals = this.riskManager.generateSignals(edges, portfolio);

      // 7. Execute signals
      for (const signal of signals) {
        await this.executeSignal(signal);
      }

      this.logger.info(`--- Cycle complete: ${signals.length} trades executed ---`);
    } catch (err) {
      this.logger.error(`Cycle failed: ${err}`);
    }
  }

  /** Start the continuous trading loop */
  async start(): Promise<void> {
    this.running = true;
    this.logger.info(`Agent starting — scanning every ${this.config.trading.scanIntervalSeconds}s`);

    while (this.running) {
      await this.runCycle();

      if (this.mode === "paper") {
        this.paperTrader.printSummary();
      }

      this.logger.info(`Sleeping ${this.config.trading.scanIntervalSeconds}s until next cycle...`);
      await sleep(this.config.trading.scanIntervalSeconds * 1000);
    }
  }

  /** Stop the trading loop */
  stop(): void {
    this.running = false;
    this.logger.info("Agent stopping...");
  }

  // --- Private ---

  private filterMarkets(markets: import("../types/index.js").KalshiMarket[]): import("../types/index.js").KalshiMarket[] {
    return markets.filter((m) => {
      // Must be open
      if (m.status !== "open") return false;

      // Must have some liquidity (at least one side has prices)
      if (m.yesAsk === 0 && m.yesBid === 0) return false;

      // Skip extreme prices (near 0 or 100 — low edge potential).
      // Use yesAsk as the price signal when yesBid is 0 (common for
      // illiquid markets where the bid side of the book is empty).
      const price = (m.yesBid > 0 && m.yesAsk > 0)
        ? (m.yesAsk + m.yesBid) / 2
        : (m.yesAsk || m.yesBid);
      if (price < 5 || price > 95) return false;

      // Must have some volume
      if (m.volume < 10) return false;

      // Category filter (if configured)
      if (this.config.trading.marketCategories.length > 0) {
        const cat = m.category.toLowerCase();
        const matchesCategory = this.config.trading.marketCategories.some(
          (c) => cat.includes(c.toLowerCase())
        );
        if (!matchesCategory) return false;
      }

      return true;
    });
  }

  private async executeSignal(signal: TradeSignal): Promise<void> {
    if (this.mode === "paper") {
      this.paperTrader.execute(signal);
    } else {
      try {
        const result = await this.kalshi.placeOrder({
          ticker: signal.edge.ticker,
          action: signal.action,
          side: signal.side,
          type: "limit",
          count: signal.contracts,
          yesPrice: signal.side === "yes" ? signal.limitPrice : undefined,
          noPrice: signal.side === "no" ? signal.limitPrice : undefined,
        });
        this.logger.info(`LIVE order placed: ${result.order.order_id}`);
      } catch (err) {
        this.logger.error(`Order failed for ${signal.edge.ticker}: ${err}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
