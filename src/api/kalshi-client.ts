// ============================================================
// Kalshi API Client
// Wraps the official SDK + raw REST calls for full coverage
// ============================================================

import crypto from "node:crypto";
import fs from "node:fs";
import type { AgentConfig, KalshiMarket } from "../types/index.js";
import type { Logger } from "../utils/logger.js";

interface KalshiOrderRequest {
  ticker: string;
  action: "buy" | "sell";
  side: "yes" | "no";
  type: "limit" | "market";
  count: number;
  yesPrice?: number;  // in cents (1–99)
  noPrice?: number;
  expiration_ts?: number;
}

interface KalshiOrderResponse {
  order: {
    order_id: string;
    status: string;
    ticker: string;
    side: string;
    action: string;
    count: number;
    yes_price: number;
    no_price: number;
    created_time: string;
  };
}

export class KalshiClient {
  private apiKeyId: string;
  private privateKey: crypto.KeyObject;
  private basePath: string;
  private logger: Logger;

  constructor(config: AgentConfig, logger: Logger) {
    this.apiKeyId = config.kalshi.apiKeyId;
    this.basePath = config.kalshi.basePath;
    this.logger = logger;

    // Load RSA private key
    let pem: string;
    if (config.kalshi.privateKeyPem) {
      pem = config.kalshi.privateKeyPem.replace(/\\n/g, "\n");
    } else if (config.kalshi.privateKeyPath) {
      pem = fs.readFileSync(config.kalshi.privateKeyPath, "utf8");
    } else {
      throw new Error("Must provide KALSHI_PRIVATE_KEY_PATH or KALSHI_PRIVATE_KEY_PEM");
    }

    this.privateKey = crypto.createPrivateKey(pem);
    this.logger.info(`Kalshi client initialized (${config.kalshi.environment})`);
  }

  // --- Authentication ---

  private signRequest(method: string, path: string): Record<string, string> {
    const timestampMs = Date.now().toString();
    // Strip query params for signing
    const pathWithoutQuery = path.split("?")[0];
    const message = timestampMs + method.toUpperCase() + pathWithoutQuery;

    const signature = crypto
      .sign("sha256", Buffer.from(message), {
        key: this.privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString("base64");

    return {
      "KALSHI-ACCESS-KEY": this.apiKeyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestampMs,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.basePath}${path}`;
    const headers = this.signRequest(method, path);

    const options: RequestInit = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    this.logger.debug(`API ${method} ${path}`);
    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kalshi API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  // --- Market Data ---

  /** Fetch all open markets, optionally filtered by category */
  async getMarkets(params?: {
    status?: string;
    seriesTicker?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KalshiMarket[]> {
    const query = new URLSearchParams();
    if (params?.status) query.set("status", params.status);
    if (params?.seriesTicker) query.set("series_ticker", params.seriesTicker);
    if (params?.limit) query.set("limit", params.limit.toString());
    if (params?.cursor) query.set("cursor", params.cursor);

    const queryStr = query.toString() ? `?${query.toString()}` : "";
    const data = await this.request<any>("GET", `/markets${queryStr}`);

    return (data.markets || []).map(this.mapMarket);
  }

  /** Fetch all open markets by paginating through results */
  async getAllOpenMarkets(): Promise<KalshiMarket[]> {
    const allMarkets: KalshiMarket[] = [];
    let cursor: string | undefined;

    do {
      const data = await this.request<any>("GET", `/markets?status=open&limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      const markets = (data.markets || []).map(this.mapMarket);
      allMarkets.push(...markets);
      cursor = data.cursor;
      this.logger.debug(`Fetched ${markets.length} markets (total: ${allMarkets.length})`);
    } while (cursor);

    return allMarkets;
  }

  /** Get a single market by ticker */
  async getMarket(ticker: string): Promise<KalshiMarket> {
    const data = await this.request<any>("GET", `/markets/${ticker}`);
    return this.mapMarket(data.market);
  }

  /** Get order book for a market */
  async getOrderBook(ticker: string, depth?: number): Promise<{
    yes: Array<{ price: number; quantity: number }>;
    no: Array<{ price: number; quantity: number }>;
  }> {
    const depthParam = depth ? `?depth=${depth}` : "";
    const data = await this.request<any>("GET", `/markets/${ticker}/orderbook${depthParam}`);
    return {
      yes: data.orderbook?.yes || [],
      no: data.orderbook?.no || [],
    };
  }

  // --- Trading ---

  /** Place an order */
  async placeOrder(order: KalshiOrderRequest): Promise<KalshiOrderResponse> {
    const body: any = {
      ticker: order.ticker,
      action: order.action,
      side: order.side,
      type: order.type,
      count: order.count,
    };

    if (order.yesPrice !== undefined) body.yes_price = order.yesPrice;
    if (order.noPrice !== undefined) body.no_price = order.noPrice;
    if (order.expiration_ts) body.expiration_ts = order.expiration_ts;

    this.logger.info(`Placing order: ${order.action} ${order.count}x ${order.side} @ ${order.yesPrice ?? order.noPrice}¢ on ${order.ticker}`);
    return this.request<KalshiOrderResponse>("POST", "/portfolio/orders", body);
  }

  /** Cancel an order */
  async cancelOrder(orderId: string): Promise<void> {
    await this.request("DELETE", `/portfolio/orders/${orderId}`);
    this.logger.info(`Cancelled order ${orderId}`);
  }

  // --- Portfolio ---

  /** Get account balance in dollars */
  async getBalance(): Promise<number> {
    const data = await this.request<any>("GET", "/portfolio/balance");
    return (data.balance ?? 0) / 100;
  }

  /** Get current positions */
  async getPositions(): Promise<any[]> {
    const data = await this.request<any>("GET", "/portfolio/positions");
    return data.market_positions || [];
  }

  // --- Helpers ---

  private mapMarket(raw: any): KalshiMarket {
    // Kalshi API statuses: initialized, inactive, active, closed,
    // determined, disputed, amended, finalized.
    // Normalize to our simpler vocabulary.
    let status: KalshiMarket["status"];
    switch (raw.status) {
      case "active":
        status = "open";
        break;
      case "closed":
        status = "closed";
        break;
      case "determined":
      case "finalized":
        status = "settled";
        break;
      default:
        status = "closed"; // initialized, inactive, disputed, amended
    }

    return {
      ticker: raw.ticker,
      eventTicker: raw.event_ticker ?? "",
      title: raw.title ?? raw.subtitle ?? raw.ticker,
      subtitle: raw.subtitle,
      category: raw.category ?? "",
      status,
      yesAsk: raw.yes_ask ?? 0,
      yesBid: raw.yes_bid ?? 0,
      noAsk: raw.no_ask ?? 0,
      noBid: raw.no_bid ?? 0,
      volume: raw.volume ?? 0,
      openInterest: raw.open_interest ?? 0,
      expirationDate: raw.expiration_time ?? raw.close_time ?? "",
      result: raw.result,
    };
  }
}
