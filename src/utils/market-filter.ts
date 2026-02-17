// ============================================================
// Market filtering utilities — shared between scan.ts and trading-agent
// ============================================================

import type { KalshiMarket } from "../types/index.js";

// Ticker patterns for markets that require real-time data the LLM
// doesn't have — weather forecasts, ultra-short-term price movements.
// The LLM adds value on markets where reasoning from training data,
// base rates, and web-searchable news is informative.
const REALTIME_DEPENDENT_PATTERNS = [
  /^KX(?:HIGH|LOW)/i,   // temperature highs/lows (need weather forecast data)
  /15M-/,               // 15-minute crypto/price markets
  /^KXQUICKSETTLE/i,    // quick-settle markets (minutes-long)
];

// Maximum bid-ask spread (in cents) for a market to be considered tradeable.
// yesAsk + noAsk = 100 + spread. A 25¢ spread is generous — most liquid
// markets have 2-10¢. Wider spreads mean the market is untradeable at
// anything close to fair value.
const MAX_SPREAD_CENTS = 25;

/**
 * Returns true if a market is suitable for LLM forecasting.
 * Filters out markets where the model has no informational edge:
 * next-day weather, 15-minute price candles, quick-settle, etc.
 */
export function isLLMForecastable(market: KalshiMarket): boolean {
  return !REALTIME_DEPENDENT_PATTERNS.some((p) => p.test(market.ticker));
}

/**
 * Returns true if the market has a tight enough spread to be tradeable.
 * Markets with yesAsk + noAsk > 125 (i.e., 25¢+ spread) produce
 * phantom edges because mid-price is far from any executable price.
 */
export function hasTightSpread(market: KalshiMarket): boolean {
  // Need both sides quoted to check spread
  if (market.yesAsk <= 0 || market.noAsk <= 0) return true; // can't check, allow through
  return (market.yesAsk + market.noAsk) <= (100 + MAX_SPREAD_CENTS);
}

/**
 * Returns the grouping key for a market (for diversification).
 * Kalshi API doesn't return category on market objects — it's on events.
 * Fall back to event ticker prefix as a proxy for topic diversity.
 */
export function getMarketGroup(market: KalshiMarket): string {
  return market.category || market.eventTicker.split("-")[0] || "other";
}

/**
 * Select candidates diversely across categories/event groups.
 * Picks the highest-volume market from each group in round-robin
 * fashion to maximize category diversity in the forecast batch.
 */
export function selectDiverseCandidates(
  markets: KalshiMarket[],
  count: number
): KalshiMarket[] {
  // Sort by volume descending so we pick the most liquid first
  const sorted = [...markets].sort((a, b) => b.volume - a.volume);

  // Group by category or event ticker prefix
  const groups = new Map<string, KalshiMarket[]>();
  for (const m of sorted) {
    const key = getMarketGroup(m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  // Round-robin: take one from each group, then repeat
  const result: KalshiMarket[] = [];
  const keys = [...groups.keys()];
  const pointers = new Map(keys.map((k) => [k, 0]));

  while (result.length < count && keys.length > 0) {
    for (let i = keys.length - 1; i >= 0; i--) {
      if (result.length >= count) break;
      const key = keys[i];
      const items = groups.get(key)!;
      const ptr = pointers.get(key)!;
      if (ptr < items.length) {
        result.push(items[ptr]);
        pointers.set(key, ptr + 1);
      } else {
        keys.splice(i, 1);
      }
    }
  }

  return result;
}
