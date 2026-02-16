# Kalshi EV Agent

An automated expected-value trading agent for [Kalshi](https://kalshi.com) prediction markets. Uses LLM-based probability forecasting (Claude) to detect mispricings and execute trades with Kelly-criterion position sizing.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Trading Agent Loop                    │
│                                                         │
│  ┌──────────┐   ┌────────────┐   ┌──────────────────┐  │
│  │  Kalshi   │──▶│   Market    │──▶│   LLM Forecaster │  │
│  │  API      │   │   Filter    │   │   (Claude)       │  │
│  └──────────┘   └────────────┘   └────────┬─────────┘  │
│                                           │             │
│                                           ▼             │
│  ┌──────────┐   ┌────────────┐   ┌──────────────────┐  │
│  │ Executor  │◀──│   Risk     │◀──│  Edge Detector   │  │
│  │ (Paper/   │   │   Manager  │   │  (EV Calculator) │  │
│  │  Live)    │   │  (Kelly)   │   │                  │  │
│  └──────────┘   └────────────┘   └──────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Cycle flow:**
1. **Fetch** all open markets from Kalshi API
2. **Filter** to liquid, mid-priced markets in your categories
3. **Forecast** probabilities using Claude (LLM-as-superforecaster)
4. **Detect edges** where model probability diverges from market price
5. **Size positions** using fractional Kelly criterion
6. **Execute** trades (paper mode for testing, live for real)

## Getting Started

### Prerequisites

- Node.js 20+
- A Kalshi account with API keys ([generate here](https://kalshi.com/account/api))
- An Anthropic API key for Claude forecasting

### Setup

```bash
# Clone and install
git clone <your-repo>
cd kalshi-ev-agent
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys
```

### Generate Kalshi API Keys

1. Log in to [Kalshi](https://kalshi.com)
2. Go to Account → API Keys
3. Generate a new key pair
4. Save the private key PEM file to `./keys/kalshi-private.pem`
5. Set `KALSHI_API_KEY_ID` in `.env`

**Start with the demo environment** (`KALSHI_ENV=demo`) — this uses play money.

### Run

```bash
# Scan markets for edges (one-shot, no trading)
npm run scan

# Run paper trading (simulated execution)
npm run paper-trade

# Run one cycle only
npm run paper-trade -- --once
```

## Configuration

All config is via environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `KALSHI_ENV` | `demo` | `demo` or `prod` |
| `MIN_EDGE_THRESHOLD` | `0.05` | Minimum edge (5%) to trigger a trade |
| `KELLY_FRACTION` | `0.25` | Fractional Kelly (25% = quarter Kelly) |
| `MAX_POSITION_USD` | `50` | Max dollars on a single contract |
| `MAX_PORTFOLIO_EXPOSURE_USD` | `500` | Max total portfolio exposure |
| `SCAN_INTERVAL_SECONDS` | `300` | How often to scan (5 min) |
| `MARKET_CATEGORIES` | `politics,economics,crypto` | Comma-separated categories |

## Key Concepts

### Expected Value (EV)

A trade has positive EV when your estimated probability exceeds the market-implied probability:

```
EV = (modelProb × payout) - cost
   = modelProb × $1 - marketPrice

If your model says 65% and market says 50¢:
EV = 0.65 × $1 - $0.50 = $0.15 per contract
```

### Kelly Criterion

Optimal bet sizing that maximizes long-run growth:

```
Kelly% = (p × b - q) / b

Where:
  p = your probability of winning
  q = 1 - p
  b = net odds (what you win / what you risk)
```

We use **fractional Kelly** (default ¼) because full Kelly is too aggressive — it assumes perfect calibration, which no model has.

### Circuit Breakers

The risk manager includes:
- **Daily loss limit** (10% of max exposure)
- **Hourly trade limit** (20 trades/hour)
- **Position concentration limit** (one position per market)
- **Portfolio exposure cap**

## Project Structure

```
src/
├── api/
│   └── kalshi-client.ts      # Kalshi REST API wrapper with RSA-PSS auth
├── agent/
│   ├── trading-agent.ts       # Main orchestration loop
│   ├── edge-detector.ts       # Compares forecasts to market prices
│   └── paper-trader.ts        # Simulated execution engine
├── forecaster/
│   └── llm-forecaster.ts      # Claude-based probability estimation
├── risk/
│   └── risk-manager.ts        # Kelly sizing + circuit breakers
├── cli/
│   ├── scan.ts                # One-shot market scanner
│   └── paper-trade.ts         # Paper trading runner
├── types/
│   └── index.ts               # All TypeScript interfaces
├── utils/
│   ├── config.ts              # Environment config loader
│   └── logger.ts              # Winston logger
└── index.ts                   # Barrel exports
```

## Roadmap

- [ ] **Phase 1 (current):** Paper trading with LLM forecaster
- [ ] **Phase 2:** News signal integration (RSS, Twitter/X, AP)
- [ ] **Phase 3:** Retrieval-augmented forecasting (inject real-time context)
- [ ] **Phase 4:** Calibration tracking and model improvement
- [ ] **Phase 5:** Live trading with position monitoring
- [ ] **Phase 6:** WebSocket integration for real-time price updates
- [ ] **Phase 7:** Multi-market arbitrage (Kalshi + Polymarket)
- [ ] **Phase 8:** Backtesting engine with historical data

## Disclaimer

This is experimental software for educational and research purposes. Trading on prediction markets carries financial risk. Always start with paper trading and the demo environment. The authors are not responsible for any financial losses.
