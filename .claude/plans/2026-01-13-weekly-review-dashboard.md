# Weekly Review Dashboard Implementation Plan

## Overview
Implementing a weekly productivity review dashboard with charts and insights for the Personal AI Assistant.

## Components to Create

### 1. Analytics Components (`src/routes/assistant/-components/analytics/`)

#### `WeeklyReview.tsx`
- Main container component
- Week selector dropdown (this week, last week, 2 weeks ago, etc.)
- Orchestrates all child components
- Handles data loading via `useWeeklyReview` hook
- Responsive grid layout

#### `WeekStats.tsx`
- Summary cards for key metrics
- Tasks completed (with week-over-week comparison, trend arrow)
- Focus time (in hours)
- Current streak
- Glass card effect with neon accents

#### `CompletionTrend.tsx`
- Area chart showing tasks over last 8 weeks
- Uses recharts AreaChart
- Neon cyan gradient fill
- Dark background with grid lines
- Tooltip showing exact values

#### `DeadlinePerformance.tsx`
- Donut/Pie chart showing on-time vs late percentage
- Uses recharts PieChart with inner radius
- Amber for on-time, rose for late
- Center label showing overall percentage

#### `EnergyByDay.tsx`
- Bar chart showing energy levels per day of week
- Uses recharts BarChart
- Emerald color scheme
- Shows pattern (e.g., "Thursday is your weak spot")

#### `WeeklyInsights.tsx`
- Terminal-styled insights panel
- AI-like recommendations
- Examples:
  - "You completed 38% more tasks this week!"
  - "Thursday is your weak spot. Try lighter tasks."
  - "Peak focus: Monday 9-11am"
- Monospace font, typing animation feel

#### `BadgesEarned.tsx`
- Grid of badges earned this week
- Uses existing badge definitions from types.ts
- Rarity-colored borders

#### `ReviewExport.tsx`
- Export button with dropdown
- Options: Copy to clipboard, Download as image (future)
- Generates shareable text summary

### 2. Update `analytics.tsx`
- Replace placeholder with `WeeklyReview` component
- Pass userId from auth

## Data Flow

```
analytics.tsx
  -> WeeklyReview
    -> useWeeklyReview(userId)
    -> useStreak(userId)
    -> useEnergyData(userId)
    -> useBadgeProgress(userId)

WeeklyReview orchestrates:
  -> WeekStats (summary cards)
  -> CompletionTrend (line chart)
  -> DeadlinePerformance (donut chart)
  -> EnergyByDay (bar chart)
  -> WeeklyInsights (recommendations)
  -> BadgesEarned (badges grid)
  -> ReviewExport (export button)
```

## Styling

### Cyberpunk Aesthetic
- Glass effect: `bg-[#0a0a14]/80 backdrop-blur-sm`
- Neon colors:
  - Cyan: `#06b6d4` (charts, primary accent)
  - Amber: `#f59e0b` (success, on-time)
  - Emerald: `#10b981` (energy, positive)
  - Rose: `#f43f5e` (late, negative)
- Corner decorations from FeatureCard
- Grid background with scan lines

### Chart Styling
- Dark background: `#0a0a14`
- Grid lines: `rgba(255,255,255,0.05)`
- Tooltips with glass effect
- Axis labels in muted gray

## Technical Notes
- Use React 19 (no useCallback/useMemo needed - React Compiler)
- recharts v3.6.0 is installed
- Use existing hooks from `@/lib/assistant/hooks`
- Use existing types from `@/lib/assistant/types`
- Authentication via `useAuth` from WorkOS
