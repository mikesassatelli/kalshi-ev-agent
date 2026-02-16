// ============================================================
// Core types for the Kalshi EV Trading Agent
// ============================================================

/** A Kalshi market with the fields we care about */
export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle?: string;
  category: string;
  status: "open" | "closed" | "settled";
  yesAsk: number;   // best ask for YES (0-100 cents)
  yesBid: number;   // best bid for YES
  noAsk: number;    // best ask for NO
  noBid: number;    // best bid for NO
  volume: number;
  openInterest: number;
  expirationDate: string;
  result?: "yes" | "no" | "voided";
}

/** Our model's probability estimate for a market */
export interface Forecast {
  ticker: string;
  modelProbYes: number;     // 0–1
  confidence: number;       // 0–1, how confident the model is in its estimate
  reasoning: string;        // LLM's chain-of-thought
  sources: string[];        // URLs / data sources used
  timestamp: Date;
}

/** A detected edge — the core signal */
export interface Edge {
  ticker: string;
  market: KalshiMarket;
  forecast: Forecast;
  side: "yes" | "no";
  marketProb: number;       // implied prob from market price
  modelProb: number;        // our model's prob for this side
  edge: number;             // modelProb - marketProb
  expectedValue: number;    // EV per dollar risked
}

/** A trade signal ready for execution */
export interface TradeSignal {
  edge: Edge;
  side: "yes" | "no";
  action: "buy" | "sell";
  contracts: number;        // number of contracts
  limitPrice: number;       // cents (1-99)
  kellyFraction: number;
  positionSizeUsd: number;
  reason: string;
}

/** Executed or paper trade record */
export interface TradeRecord {
  id: string;
  signal: TradeSignal;
  executedAt: Date;
  fillPrice?: number;
  filled: boolean;
  orderId?: string;
  pnl?: number;             // filled in after settlement
  mode: "paper" | "live";
}

/** Portfolio state */
export interface Portfolio {
  balanceUsd: number;
  positions: Position[];
  totalExposureUsd: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface Position {
  ticker: string;
  side: "yes" | "no";
  contracts: number;
  avgPrice: number;
  currentPrice: number;
  marketTitle: string;
}

/** Agent configuration (loaded from env) */
export interface AgentConfig {
  kalshi: {
    apiKeyId: string;
    privateKeyPath?: string;
    privateKeyPem?: string;
    environment: "prod" | "demo";
    basePath: string;
  };
  anthropic: {
    apiKey: string;
  };
  trading: {
    minEdgeThreshold: number;
    kellyFraction: number;
    maxPositionUsd: number;
    maxPortfolioExposureUsd: number;
    scanIntervalSeconds: number;
    marketCategories: string[];
  };
  logLevel: string;
}
