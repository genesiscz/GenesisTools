# 010 - Debt Snowball Tracker

## Overview
A debt payoff system that tracks loans, credit card balances, and other debts with progress visualization, payoff strategy recommendations, interest savings calculations, and motivating progress tracking. Helps users visualize debt elimination and celebrate payoffs while integrating with spending and savings goals for comprehensive financial health.

## Purpose & Goals
- Make debt payoff visible and motivating
- Show progress toward being debt-free
- Calculate interest savings from early payoff
- Support multiple debt payoff strategies (snowball, avalanche)
- Celebrate debt milestones and completions
- Integrate debt payoff with spending and savings tracking
- Reduce financial stress through transparency

## Key User Flows

### 1. Add Debt
- User adds debt to track
- Fields:
  - Creditor name (bank, credit card, etc.)
  - Debt type (credit card, loan, mortgage, etc.)
  - Current balance owed
  - Interest rate (APR)
  - Minimum payment amount
  - Due date
  - Target payoff date (optional)
  - Notes
- System calculates interest accumulation and payoff timeline

### 2. Debt Dashboard Overview
- Total debt owed prominently displayed
- Progress ring showing % paid off
- "You've eliminated $5,000 of debt. $15,000 remaining."
- List of all debts with individual progress
- Sorted options: balance, interest rate, due date
- Total interest paid to date
- Total interest remaining (if current trajectory)

### 3. Payoff Strategy
- Snowball strategy: pay smallest debt first (psychological wins)
- Avalanche strategy: pay highest interest first (mathematically optimal)
- Hybrid strategy: recommended payoff order
- System shows: "If you pay $500/month on [Debt], you'll pay off in 30 months"
- Interest saved by accelerating payments: "Pay $600/month → Save $2,000 interest"

### 4. Progress Visualization
- Individual debt progress bars
- Timeline showing projected payoff dates
- Interest reduction graph
- Monthly payment breakdown
- Payoff milestones: "Next: Eliminate credit card #1 in 8 months"

### 5. Payoff Tracking
- Log payments as they're made
- Manual entry or auto-sync from spending tracker
- Update balances periodically
- Track extra payments (snowball acceleration)
- Show months remaining for each debt

### 6. Payoff Achievements & Milestones
- Celebration when debt reaches 25%, 50%, 75%, 100% paid
- Achievement badge: "Paid off $5,000!"
- "You're debt-free on credit card #2! 🎉"
- Annual debt reduction: "You eliminated $8,000 debt this year"
- Total interest saved vs. minimum payments

## Data Model

```typescript
interface Debt {
  id: string
  userId: string
  creditorName: string
  debtType: DebtType // "credit_card", "personal_loan", "mortgage", "student_loan", "other"
  originalBalance: number
  currentBalance: number
  minimumPayment: number
  interestRate: number // APR as percentage
  dueDate: DateTime
  targetPayoffDate?: DateTime

  // Payment history
  payments: Array<{
    date: DateTime
    amount: number
    notes?: string
  }>

  // Interest tracking
  totalInterestPaid: number
  projectedInterestRemaining: number
  payoffStrategy?: "snowball" | "avalanche" | "hybrid"

  // Metadata
  notes?: string
  isFocused: boolean // Which debt to prioritize payoff
  accountNumber?: string // Last 4 digits only

  createdAt: DateTime
  updatedAt: DateTime
}

type DebtType = "credit_card" | "personal_loan" | "mortgage" | "student_loan" | "auto_loan" | "medical" | "other"

interface PayoffStrategy {
  userId: string
  strategyType: "snowball" | "avalanche" | "hybrid"
  debts: Array<{
    debtId: string
    payoffOrder: number
    suggestedMonthlyPayment: number
    projectedPayoffDate: DateTime
    interestSaved: number
  }>
  totalMonthlyPayment: number
  projectedDebtFreeDate: DateTime
  totalInterestSaved: number
  createdAt: DateTime
}

interface DebtMilestone {
  id: string
  userId: string
  debtId: string
  milestonePercent: number // 25, 50, 75, 100
  achievedDate: DateTime
  balanceAtAchievement: number
}

interface NetWorthSnapshot {
  id: string
  userId: string
  totalAssets: number // Investments, savings
  totalDebts: number
  netWorth: number // assets - debts
  timestamp: DateTime // Daily snapshots
}
```

## UI Components

### Add Debt Modal
- Form with fields:
  - Creditor name
  - Debt type dropdown
  - Current balance
  - Interest rate (APR)
  - Minimum payment
  - Due date
  - Target payoff date (optional)
  - Notes
- Submit button
- Can add multiple debts

### Debt Dashboard Page
- Tabs: Overview | Debts | Strategy | Progress | Milestones
- Overview tab:
  - Large "Total Debt: $20,000" display
  - Total minimum payment monthly
  - Total interest paid to date: "$2,450"
  - Projected interest remaining: "$3,200"
  - Interest saved vs. minimum payments (if paying extra)
  - Progress ring: 25% paid off
  - "Debt-free in 36 months at current pace"
  - Quick add debt button
- Debts tab:
  - Table/list of all debts:
    - Creditor name
    - Debt type
    - Current balance
    - Interest rate
    - Minimum payment
    - Payoff date (projected)
    - Progress bar (% paid off)
  - Sortable by balance, interest rate, due date
  - Click to view debt details
  - Mark as focused (for strategy)
- Strategy tab:
  - Current strategy selection (snowball/avalanche)
  - Recommended payoff order:
    - Debt 1: pay $X/month → payoff in 12 months
    - Debt 2: pay $Y/month → payoff in 18 months (after #1 paid)
    - Debt 3: pay $Z/month → payoff in 24 months (after #2 paid)
  - "This strategy saves you $X in interest"
  - Alternative strategy comparison
  - Adjust monthly payment slider to see impact
  - "If you pay $600/month: debt-free in 24 months"
- Progress tab:
  - Timeline showing payoff milestones
  - Monthly interest savings graph
  - Remaining balance line chart
  - Payment history
  - Extra payments highlight
- Milestones tab:
  - Recent milestone celebrations
  - "Paid off $5,000 (25% of credit card debt)"
  - Date achieved
  - Interest saved so far
  - Next milestone progress

### Debt Detail Page
- Debt name and type
- Current balance and progress bar
- Interest rate and monthly interest accrual
- Payment history (recent payments listed)
- Payoff timeline: "30 months remaining"
- Log payment button
- Estimated payoff date
- Total interest paid vs. remaining
- Update balance option

### Payoff Strategy Recommendation
- Shows three options side-by-side:
  - Snowball: "Pay smallest first"
  - Avalanche: "Pay highest interest first"
  - Hybrid: "Optimized for psychology + math"
- For each strategy:
  - Payoff timeline
  - Interest saved
  - Debt-free date
- Select strategy button
- Ability to customize monthly payment amounts

### Milestone Celebration Modal
- Full-screen celebration when milestone hit
- Confetti animation
- Achievement badge
- "You've paid off 50% of your credit card debt! 🎉"
- Progress to next milestone: "1 year to 75%"
- Share milestone button (optional)

### Debt Widget
- Dashboard home shows:
  - Total debt: "$20,000"
  - Progress: "25% paid off"
  - Debt-free date: "December 2025"
  - Trending indicator (↓ debt is good)

### Monthly Payment Tracker
- Shows all payments due this month
- Total minimum payment
- Interest accruing
- Next due dates
- Log payment button
- Quick payment logging

## Integration Points

**Spending Tracker Integration:**
- Payments appear in spending history
- Compare spending vs. debt payoff payments
- Budget allocation: "You spent $200 on restaurants, could pay debt instead"
- Set debt payoff as spending goal

**Investment Dashboard Integration:**
- Net worth view: assets - debt = net worth
- "Paying off debt faster than investments growing"
- Prioritization: "Pay 8% interest debt before 3% return on bonds"

**Accountability Network:**
- Share debt payoff goal with accountability partner
- "Let's both be debt-free by 2025"
- Partner sees progress (not specific debts unless shared)
- Mutual accountability and celebration

**Financial Dashboard (Future):**
- Combined view: spending, savings, investments, debt
- Overall financial health score
- Recommended debt payoff strategy considering all finances

**Savings Goals Integration:**
- Emergency fund goal + debt payoff goal balance
- "Allocate 70% to debt, 30% to savings"

## Success Criteria

- Adding debt takes <2 minutes
- Progress is always visible and motivating
- Payoff strategy is clear and easy to follow
- Monthly interest calculations are accurate
- Milestones celebrate progress without shame
- Users feel motivated to accelerate payoff
- Integration with spending/savings is seamless

## Technical Considerations

- Interest calculation (compound interest formulas)
- Payoff date projections
- Strategy optimization (snowball vs. avalanche calculations)
- Payment tracking and history
- Net worth tracking (daily snapshots)
- Monthly interest accrual calculations

## Error Handling

- Invalid interest rates: validate 0-30% range
- Negative balances: prevent, but allow overpayment
- Duplicate debts: warn user
- Payment amounts: validate positive numbers
- Future due dates: warn if past due

## Motivational Elements

- Positive language: "You've paid off $X" not "You owe $Y"
- Celebration for milestones (no judgment for late payoff)
- Interest savings highlighted (motivation to accelerate)
- Progress always visible (not hidden until goal)
- Debt-free date countdown

## Privacy Considerations

- Sensitive debt information (account numbers, balances)
- Store last 4 digits of account only (not full numbers)
- Sharing with accountability partner is optional
- No public debt disclosures

## Related Features

- Spending Tracker: shows spending patterns affecting payoff
- Savings Goals: balance between saving and paying debt
- Investment Dashboard: net worth calculation
- Accountability Network: shared payoff goals
- Financial Dashboard: comprehensive financial view

## Open Questions

1. Should we suggest minimum payment adjustments?
2. Should we integrate with banking APIs for auto-payment import?
3. Should we track credit score impact (informational)?
4. Should we provide educational resources on debt reduction?
5. Should we support payment automation (recurring payments)?
