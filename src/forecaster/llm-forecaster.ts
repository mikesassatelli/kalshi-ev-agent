// ============================================================
// LLM Forecaster — Uses Claude to estimate probabilities
// ============================================================

import type { KalshiMarket, Forecast, AgentConfig } from "../types/index.js";
import type { Logger } from "../utils/logger.js";

const FORECASTER_SYSTEM_PROMPT = `You are a world-class probability forecaster, trained in the tradition of superforecasting (Tetlock). Your job is to estimate the probability that a prediction market contract resolves YES.

You must:
1. Consider base rates for this type of event
2. Identify the key factors that could push the probability up or down
3. Consider the time horizon and how much could change
4. Be well-calibrated: your 70% predictions should come true ~70% of the time
5. Avoid anchoring to the current market price — reason independently
6. Think about what information the market might be missing or overweighting
7. If you lack current information needed to forecast accurately, lower your confidence and note this in your reasoning

IMPORTANT: Your training data has a knowledge cutoff. For questions about recent events, current data, or fast-moving situations, acknowledge what you don't know and reflect that uncertainty in both your probability and confidence scores. A low-confidence estimate is far more useful than a falsely precise one.

Output your response as JSON with this exact structure:
{
  "probability": <number between 0 and 1>,
  "confidence": <number between 0 and 1, how confident you are in your estimate>,
  "reasoning": "<your step-by-step reasoning>",
  "key_factors_yes": ["<factor 1>", "<factor 2>"],
  "key_factors_no": ["<factor 1>", "<factor 2>"],
  "base_rate_estimate": <number or null if not applicable>,
  "information_edge": "<what might the market be missing, or null if you have no informational advantage>"
}

Be precise. Be calibrated. Don't hedge excessively — give your best estimate.`;

const WEB_SEARCH_ADDENDUM = `

You have access to web search. Use it to look up current information before forming your estimate — especially for questions about recent events, current polls, economic data, or anything that may have changed since your training data cutoff. Search first, then reason.`;

const MAX_RETRIES = 3;

export class LLMForecaster {
  private apiKey: string;
  private logger: Logger;
  private model = "claude-sonnet-4-20250514";
  private useWebSearch: boolean;

  constructor(config: AgentConfig, logger: Logger) {
    this.apiKey = config.anthropic.apiKey;
    this.logger = logger;
    this.useWebSearch = config.forecaster?.enableWebSearch ?? false;

    if (this.useWebSearch) {
      this.logger.info("Forecaster: web search enabled (adds ~$0.01/search + token costs)");
    }
  }

  /** Generate a probability forecast for a single market */
  async forecast(market: KalshiMarket, context?: string): Promise<Forecast> {
    const userPrompt = this.buildPrompt(market, context);
    const systemPrompt = this.useWebSearch
      ? FORECASTER_SYSTEM_PROMPT + WEB_SEARCH_ADDENDUM
      : FORECASTER_SYSTEM_PROMPT;

    this.logger.debug(`Forecasting: ${market.ticker} — ${market.title}`);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.useWebSearch ? 4096 : 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    };

    // Enable Anthropic's server-side web search tool
    if (this.useWebSearch) {
      body.tools = [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
        },
      ];
    }

    // Call API with retry on rate limits
    const data = await this.callWithRetry(body, market.ticker);

    // Extract text blocks (the model's reasoning + JSON output)
    const text = data.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Extract source URLs from web search results (if any)
    const sources: string[] = data.content
      .filter((b: any) => b.type === "web_search_tool_result")
      .flatMap((b: any) =>
        (b.content || [])
          .filter((r: any) => r.type === "web_search_result")
          .map((r: any) => r.url)
      )
      .filter(Boolean);

    const parsed = this.parseResponse(text);

    const forecast: Forecast = {
      ticker: market.ticker,
      modelProbYes: parsed.probability,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      sources,
      timestamp: new Date(),
    };

    const searchNote = sources.length > 0 ? ` [${sources.length} sources]` : "";
    this.logger.info(
      `Forecast for ${market.ticker}: ${(forecast.modelProbYes * 100).toFixed(1)}% YES ` +
      `(confidence: ${(forecast.confidence * 100).toFixed(0)}%) — ` +
      `market: ${market.yesAsk}¢${searchNote}`
    );

    return forecast;
  }

  /** Batch forecast multiple markets (sequential to respect rate limits) */
  async forecastBatch(
    markets: KalshiMarket[],
    context?: string,
    delayMs?: number
  ): Promise<Forecast[]> {
    // Web search forecasts consume ~15-25k tokens each; with a 30k/min
    // rate limit we need ~60s between calls. Without web search, 1s is fine.
    const effectiveDelay = delayMs ?? (this.useWebSearch ? 60_000 : 1000);

    if (this.useWebSearch) {
      this.logger.info(
        `Web search mode: ${effectiveDelay / 1000}s delay between forecasts ` +
        `(~${Math.ceil(markets.length * effectiveDelay / 60_000)} min for ${markets.length} markets)`
      );
    }

    const forecasts: Forecast[] = [];
    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];
      try {
        const forecast = await this.forecast(market, context);
        forecasts.push(forecast);
        // Rate limit courtesy delay (skip after last market)
        if (effectiveDelay > 0 && i < markets.length - 1) {
          await sleep(effectiveDelay);
        }
      } catch (err) {
        this.logger.error(`Forecast failed for ${market.ticker}: ${err}`);
      }
    }
    return forecasts;
  }

  /** Call the Anthropic API with retry + exponential backoff on 429s */
  private async callWithRetry(body: Record<string, unknown>, ticker: string): Promise<any> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          const err = await response.text();
          throw new Error(`Rate limited after ${MAX_RETRIES} retries: ${err}`);
        }

        // Use retry-after header if available, otherwise exponential backoff
        const retryAfterSec = parseInt(response.headers.get("retry-after") || "0", 10);
        const backoffMs = retryAfterSec > 0
          ? retryAfterSec * 1000
          : Math.min(15_000 * Math.pow(2, attempt), 120_000); // 15s, 30s, 60s

        this.logger.warn(
          `Rate limited on ${ticker}, waiting ${(backoffMs / 1000).toFixed(0)}s ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        await sleep(backoffMs);
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${err}`);
      }

      return response.json();
    }
  }

  private buildPrompt(market: KalshiMarket, context?: string): string {
    const parts = [
      `# Market Contract`,
      `**Title:** ${market.title}`,
      market.subtitle ? `**Subtitle:** ${market.subtitle}` : "",
      `**Ticker:** ${market.ticker}`,
      `**Category:** ${market.category}`,
      `**Expiration:** ${market.expirationDate}`,
      `**Current Market Prices:** YES ask: ${market.yesAsk}¢ | YES bid: ${market.yesBid}¢ | NO ask: ${market.noAsk}¢ | NO bid: ${market.noBid}¢`,
      `**Volume:** ${market.volume} contracts | Open Interest: ${market.openInterest}`,
      "",
      `Today's date is: ${new Date().toISOString().split("T")[0]}`,
      "",
      `What is the probability this contract resolves YES?`,
    ];

    if (context) {
      parts.push("", "# Additional Context", context);
    }

    return parts.filter(Boolean).join("\n");
  }

  private parseResponse(text: string): {
    probability: number;
    confidence: number;
    reasoning: string;
  } {
    try {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        probability: clamp(parsed.probability, 0.01, 0.99),
        confidence: clamp(parsed.confidence, 0, 1),
        reasoning: parsed.reasoning || "No reasoning provided",
      };
    } catch {
      this.logger.warn("Failed to parse LLM response as JSON, attempting extraction");
      // Fallback: try to find a probability number
      const probMatch = text.match(/probability["\s:]*([0-9.]+)/i);
      return {
        probability: probMatch ? clamp(parseFloat(probMatch[1]), 0.01, 0.99) : 0.5,
        confidence: 0.3,
        reasoning: text.slice(0, 500),
      };
    }
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
