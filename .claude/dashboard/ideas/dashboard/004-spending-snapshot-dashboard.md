# 004 - Spending Snapshot Dashboard

## Overview
A spending awareness system that logs daily purchases without strict budgeting constraints. Emphasizes quick event-based logging and pattern discovery through visualization. Shows trends, category breakdowns, spending heatmaps by time/day, anomaly detection, and progress toward savings goals. Designed for financial awareness, not restrictive budgeting.

## Purpose & Goals
- Track where money goes without strict budgets or guilt
- Identify spending patterns and trends over time
- Detect anomalies: "That $200 grocery run is unusual"
- Show spending distribution by category and time
- Support savings goals by showing progress, not restrictions
- Provide spending insights: "You spend 15% more on weekends" or "Coffee costs average $13, 3x/week"
- Enable smarter spending decisions through visibility

## Key User Flows

### 1. Quick Spending Log
- User sees floating action or quick-add from any page
- Minimal entry: Amount + description
  - Dollar amount field (auto-focus)
  - Short description ("$12 coffee", "$45 groceries", "$8 lunch")
  - Auto-detect category from description (ML-optional)
  - Timestamp auto-set
  - Optional receipt photo
  - Optional notes ("Organic salad", "Splurge", "Bulk buy")
- Submit in 10-15 seconds
- Optional: recurring expenses (weekly groceries, monthly subscription)

### 2. Daily Spending View
- Today's total spending prominently displayed
- Timeline of all purchases today with times
- Category breakdown as pie chart
- Average spend per day this week
- "You've spent $47 today vs. $52 daily average"

### 3. Weekly Spending Dashboard
- 7-day spending trend (bar chart)
- Weekly total vs. previous weeks
- Category breakdown with spending per category
- Days sorted by spending (highest to lowest)
- "This week: $384 (avg $55/day) vs. last week: $418"

### 4. Monthly Spending Analytics
- Monthly total spending over multiple months (trend line)
- Category breakdown with percentages (housing, food, entertainment, etc.)
- Spending by day of week (Mon-Sun comparison)
- Spending by time of day heatmap (when do you spend most?)
- Best/worst spending days highlighted
- "You spend 15% more on weekends"

### 5. Anomaly Detection & Insights
- "That $200 grocery run is unusual (normal: $45-60)"
- "Coffee spending: avg $13 per visit, 3x/week = ~$156/month"
- "Friday nights: 40% higher spending than weekday evenings"
- "You spent more this week than the last 4 weeks"
- "Restaurant category up 25% this month"

### 6. Savings Goals
- Set goal: "Save $500 this month for vacation"
- Track spending vs. savings target
- "You've spent $380. Budget remaining: $120 for 10 days"
- Goal progress ring showing progress toward savings target
- Multi-goal support (vacation, emergency fund, investment)

### 7. Recurring/Subscription Tracking
- Add recurring expenses (monthly rent, weekly groceries)
- Auto-populate as "expected spending"
- Track: "Netflix: $15/mo, Gym: $50/mo, Groceries: ~$200/mo"
- Notification when recurring expense comes due
- Spot new subscriptions that appeared without manual addition

## Data Model

```typescript
interface SpendingLog {
  id: string
  userId: string
  dateTime: DateTime
  amount: number // in dollars
  description: string // "Coffee", "Groceries", "Gas"
  category: SpendingCategory
  notes?: string // Optional details
  receiptPhoto?: string // Optional receipt image URL
  isRecurring?: boolean
  tags?: string[] // "splurge", "necessity", "gift"
  createdAt: DateTime
  updatedAt: DateTime
}

type SpendingCategory =
  | "food"
  | "groceries"
  | "entertainment"
  | "transportation"
  | "subscriptions"
  | "shopping"
  | "utilities"
  | "other"

interface SavingsGoal {
  id: string
  userId: string
  name: string // "Vacation fund"
  targetAmount: number
  currentAmount: number // Money saved toward goal
  deadline?: DateTime
  category?: SpendingCategory // Track spending in specific category toward goal
  createdAt: DateTime
}

interface RecurringExpense {
  id: string
  userId: string
  description: string
  amount: number
  frequency: "daily" | "weekly" | "monthly" | "yearly"
  nextDueDate: DateTime
  category: SpendingCategory
  createdAt: DateTime
}

interface SpendingInsight {
  type: "anomaly" | "pattern" | "trend"
  message: string // "That $200 is unusual for groceries"
  severity: "low" | "medium" | "high"
  date: DateTime
}
```

## UI Components

### Quick Spending Card
- Floating action button with dollar sign or receipt icon
- Modal with minimal fields:
  - Large dollar amount input (auto-focus)
  - Description field with autocomplete
  - Category selector (optional, auto-detects from description)
  - Notes textarea (optional)
  - Receipt photo button (optional)
  - Submit button
- Keyboard opens automatically for quick number entry
- Submit closes modal immediately

### Spending Dashboard Page
- Tabs: Daily | Weekly | Monthly | Goals | Recurring | Insights
- Daily tab:
  - Large display of "Today's spending: $47"
  - Small sparkline showing last 7 days
  - Timeline list of all purchases today with times
  - Category pie chart for today
  - Quick add button
  - "Daily average this week: $52"
- Weekly tab:
  - Bar chart: 7 days with amounts
  - Weekly total prominently displayed
  - Category breakdown as horizontal bar chart
  - "This week vs. last week: +$32 (+8%)"
  - Best/worst days highlighted
- Monthly tab:
  - Line chart: spending over last 6 months
  - Category pie chart for current month
  - Spending by day of week (heatmap or bar chart)
  - Time of day heatmap (when do you spend most?)
  - "This month on track" or "30% over last month"
- Goals tab:
  - List of active savings goals
  - Each goal shows progress ring with % complete
  - "Vacation: $420/$500 (84%) by July 15"
  - Time remaining and daily savings needed
  - Option to add new goal
  - Completed goals archive
- Recurring tab:
  - List of recurring/subscription expenses
  - Total monthly recurring: $XXX
  - Next due dates highlighted
  - "Netflix: $15/mo, Gym: $50/mo, Groceries: ~$200/mo"
  - Alert for new subscriptions detected
- Insights tab:
  - Anomaly cards: "That $200 grocery is unusual"
  - Pattern cards: "You spend 15% more weekends"
  - Trend cards: "Coffee cost rising (avg $12 → $14/month)"
  - Actionable suggestions: "Consider bulk grocery shopping"

### Spending Widget
- Dashboard home shows "This month: $1,247" with trend indicator
- Quick add button
- Current goals progress

## Integration Points

**Accountability Network:**
- Share spending goals with accountability partner
- "We both committed to saving $500 for trip"
- Partner can see progress (motivational)
- Shared budget challenges: "Save $100 this week together"

**Savings Goals Integration:**
- Set savings target and track progress
- System shows: "You need to spend $X less to hit goal"
- Positive framing: "You're on track" vs. "You overspent"

**Activity Log Integration:**
- Purchases appear in activity timeline
- "Spent $47 on lunch at restaurant" + "Timed 30-min focus session"
- Correlations: "Lunch time: when you take breaks"

**Calendar Integration (Relationship Calendar):**
- Track spending for events/dates
- "Birthday gifts", "Anniversary dinner"
- Remember spending patterns around important dates

## Success Criteria

- Users can log spending in <15 seconds
- System identifies 2-3 spending patterns within 1 week
- Anomalies detected correctly (outliers flagged)
- Savings goals track progress intuitively
- No guilt-based language; positive framing only
- Insights are actionable and accurate

## Technical Considerations

- Fast category detection using keyword matching
- Anomaly detection: statistical analysis of category averages
- Heatmap visualization (spending by time/day)
- Recurring expense scheduler (cron-like)
- Timezone-aware timestamps
- LocalStorage for quick access to recent spending
- Optional: receipt OCR for amount extraction

## Error Handling

- Invalid amounts prevented (negative/non-numeric)
- Future dates prevented
- Duplicate entries on same second: allowed (multiple purchases possible)
- Missing category: auto-assign "Other" with suggestion
- Orphaned goals: warn if deleting goal with progress
- Subscription detection: confirm before auto-adding

## Privacy Considerations

- All spending data private by default
- Goal sharing optional (amount visible, not itemized purchases)
- No integration with banks (manual entry only)
- No advertisement based on spending habits
- Exportable data for user's tax/finance tracking

## Privacy/Security Notes

- If receipt photos stored, encrypted and accessible only to user
- No cloud sync without explicit opt-in
- Data ownership remains with user

## Related Features

- Integrates with Accountability Network (shared goals)
- Part of larger Financial Dashboard (investments, debt, savings)
- Could feed into Portfolio (track freelance income vs. spending)
- Supports financial goal-setting in Accountability Network

## Open Questions

1. Should we integrate with bank APIs for automatic transaction import?
2. How should we handle credit card categories vs. cash purchases?
3. Should we offer budgeting recommendations based on patterns?
4. How granular should categories be? (Current: 8 broad categories)
5. Should we support multiple currencies for travelers?
