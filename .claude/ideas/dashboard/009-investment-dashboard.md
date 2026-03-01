# 009 - Investment Dashboard

## Overview
A portfolio tracking system for stocks, crypto, and other investments. Provides simple investment logging, performance visualization, portfolio allocation breakdown, gain/loss tracking, and integration with savings goals and spending analytics for comprehensive financial health view.

## Purpose & Goals
- Track investment portfolio performance without complexity
- Understand asset allocation and diversification
- See gains/losses and total return percentage
- Monitor long-term wealth building progress
- Integrate with savings goals and spending patterns
- Provide insights without requiring financial expertise
- Support multiple asset classes (stocks, crypto, real estate, bonds, etc.)

## Key User Flows

### 1. Add Investment
- User adds investment to track
- Fields:
  - Asset name (ticker symbol or crypto name)
  - Asset type (stock, crypto, real estate, ETF, bond, etc.)
  - Quantity owned (shares or coins)
  - Purchase price per unit
  - Current price (auto-fetch from API if available)
  - Purchase date
  - Optional notes
- System calculates current value, gain/loss, percentage return
- Optional: add multiple purchases of same asset (cost basis tracking)

### 2. Portfolio Overview
- Total portfolio value prominently displayed
- Total gain/loss in dollars and percentage
- "You're up $2,450 (12% return)"
- Portfolio allocation pie chart:
  - Stocks: 60%
  - Crypto: 25%
  - Bonds: 15%
- Asset breakdown table:
  - Asset name
  - Quantity
  - Current price
  - Current value
  - Gain/loss
  - Percentage return
  - Sparkline showing price trend

### 3. Performance Tracking
- Portfolio value over time (line graph)
- 1-month, 3-month, 1-year, all-time views
- Total return calculation
- Benchmark comparison (S&P 500, Nasdaq, etc.)
- Best/worst performing assets
- Volatility indicator (how stable is portfolio)

### 4. Dividend & Income Tracking
- Track dividend-paying stocks
- Crypto staking rewards
- Real estate rental income
- Monthly/annual income from investments
- "Annual dividend income: $1,200"

### 5. Investment Goals
- Set target portfolio size: "Reach $100k by 2030"
- Track progress toward goal
- Estimated time to reach goal based on returns
- Savings rate impact: "You need to save $X/month to hit goal"
- Integrate with Spending Tracker spending goals

## Data Model

```typescript
interface Investment {
  id: string
  userId: string
  assetName: string // "Apple Inc.", "Bitcoin", "Vanguard S&P 500"
  assetType: InvestmentType // "stock", "crypto", "etf", "bond", "real_estate"
  ticker?: string // "AAPL", "BTC", "VOO"
  quantity: number
  currentPrice: number
  currentValue: number // quantity * currentPrice
  totalCost: number // total amount paid for this investment
  gains: number // currentValue - totalCost
  gainPercent: number // (gains / totalCost) * 100
  lastUpdated: DateTime

  // Purchase history for cost basis
  purchases: Array<{
    date: DateTime
    quantity: number
    pricePerUnit: number
    totalCost: number
  }>

  // Income
  dividendIncome?: number // annual or cumulative
  dividendPaymentDates?: DateTime[] // When dividends paid
  otherIncome?: number // Real estate rental, staking, etc.

  notes?: string
  createdAt: DateTime
  updatedAt: DateTime
}

type InvestmentType = "stock" | "crypto" | "etf" | "bond" | "real_estate" | "commodity" | "other"

interface Portfolio {
  id: string
  userId: string
  totalValue: number
  totalCost: number
  totalGains: number
  totalGainPercent: number
  allocation: Map<InvestmentType, number> // percentage breakdown
  lastUpdated: DateTime
}

interface PortfolioSnapshot {
  id: string
  userId: string
  portfolioValue: number
  timestamp: DateTime // Daily snapshots for charting
}

interface InvestmentGoal {
  id: string
  userId: string
  goalName: string // "Reach $100k"
  targetValue: number
  deadline: DateTime
  currentProgress: number // auto-calculated
  monthlyContribution?: number // Savings needed monthly
  estimatedAchievementDate: DateTime
  createdAt: DateTime
}
```

## UI Components

### Add Investment Modal
- Form with fields:
  - Asset name/ticker with autocomplete
  - Asset type dropdown
  - Quantity input
  - Purchase price per unit
  - Current price (auto-fetch option or manual)
  - Purchase date
  - Notes (optional)
- Submit button
- Can add multiple purchases for same asset

### Portfolio Dashboard
- Tabs: Overview | Assets | Performance | Goals | Income
- Overview tab:
  - Large portfolio value display: "$47,250"
  - Total gains/losses: "+$2,450 (+5.5%)"
  - Allocation pie chart (interactive)
  - Recent price changes (sparklines for each major asset)
  - Quick add investment button
- Assets tab:
  - Table of all holdings:
    - Asset name/ticker
    - Quantity
    - Current price
    - Current value
    - Cost basis
    - Gain/loss in dollars and percent
    - Sparkline (7-day price trend)
  - Sortable by value, gain%, type, etc.
  - Click asset to see detailed history
- Performance tab:
  - Line chart: portfolio value over time
  - Time period selector (1m, 3m, 1y, 5y, all)
  - Total return percentage for period
  - Best/worst performing assets
  - Volatility metric
  - Comparison option (vs. S&P 500, Nasdaq)
- Goals tab:
  - Investment goals with progress
  - "Reach $100k by 2030: $47,250/$100,000 (47%)"
  - Time remaining and monthly savings needed
  - "At current pace, you'll reach goal in 8 years"
- Income tab:
  - Dividend income tracking
  - "Annual dividend income: $1,200"
  - Monthly income breakdown
  - Staking/other income
  - Income over time

### Investment Detail Page
- Asset name, type, ticker
- Current price and price change (% and $)
- Holdings:
  - Total shares/quantity
  - Average cost per unit
  - Total cost
  - Current value
  - Total gain/loss
- Price chart (sparkline to full chart)
- Purchase history table
- Dividend history (if applicable)
- News/info about asset (optional)

### Portfolio Widget
- Dashboard home shows portfolio snapshot
- "Portfolio: $47,250 (+$2,450 +5.5%)"
- Allocation pie mini-chart
- Link to expand full portfolio

### Asset Allocation Pie Chart
- Interactive pie chart
- Slice size = percentage allocation
- Click slice to filter to that asset type
- Hover to see value and percentage
- Colors distinguish asset types

## Integration Points

**Spending Tracker Integration:**
- Compare spending vs. investment income
- "Annual dividend income ($1,200) covers monthly groceries"
- Show spending relative to investment gains

**Savings Goals Integration:**
- Investment goal syncs with spending/savings goals
- "Aim to save $X/month to reach $100k portfolio"
- Combined view of all financial goals

**Accountability Network:**
- Share investment goals with partner
- "Let's both reach $100k portfolio by 2030"
- Partner can see portfolio growth (not individual holdings)
- Shared investing challenges

**Financial Dashboard (Future):**
- Combined net worth view: portfolio + savings - debt
- Overall financial health score
- Allocation across all assets

## Success Criteria

- Portfolio adds take <2 minutes
- Current portfolio value always accurate and up-to-date
- Performance metrics are correct (gains, percentages)
- Price updates happen automatically if using API
- Users understand portfolio allocation
- Goals feel achievable and motivating

## Technical Considerations

- API integration for real-time price data (Alpha Vantage, CoinGecko, etc.)
- Portfolio calculations (weighted average cost basis)
- Performance charting (multiple time periods)
- Daily snapshots for historical tracking
- Tax lot tracking (for tax reporting)
- Optional: import from CSV or Robinhood/Fidelity APIs

## Error Handling

- Invalid ticker symbols: suggest corrections
- Negative quantities: prevent
- Price data missing: show manual entry option
- Duplicate holdings: allow multiple buys of same asset
- Goal calculation: handle scenarios where goal not achievable

## Privacy & Security

- All portfolio data private
- No sharing of specific holdings (only summaries)
- No API keys or credentials stored
- Encryption for sensitive portfolio data

## Tax Considerations (Future)

- Gain/loss calculation for tax reporting
- Identify long-term vs. short-term gains
- Export capital gains for tax filing
- Integration with tax prep software (optional)

## Related Features

- Spending Dashboard: spending vs. investment income
- Savings Goals: overall financial targets
- Accountability Network: shared investment goals
- Debt Snowball Tracker: net worth includes investments minus debt
- Financial Dashboard (future): combined net worth view

## Open Questions

1. Should we support real estate valuation/estimates?
2. Should we track currency exposure for international investments?
3. Should we provide investment recommendations or education?
4. Should we integrate with brokerage APIs for auto-import?
5. Should we support options/derivatives tracking?
