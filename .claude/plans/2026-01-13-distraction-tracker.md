# Distraction Tracker Implementation Plan

## Overview
Implement a system to log interruptions and visualize distraction patterns for the Personal AI Assistant dashboard.

## Files to Create

### 1. Components in `src/routes/assistant/-components/distractions/`

#### `QuickLogButton.tsx`
- Floating action button with subtle pulse animation
- Opens the distraction log modal
- Keyboard shortcut support (Ctrl+D)
- Cyberpunk neon styling

#### `DistractionLogModal.tsx`
- Source selector with icons (Slack, Email, Meeting, Coworker, Hunger, Other)
- Optional description textarea
- Auto-fill task interrupted if task in progress
- Neon-colored source icons

#### `DistractionStats.tsx`
- Distribution pie chart with recharts
- Glow effect on chart segments
- Source breakdown with counts and percentages
- Total distractions and time lost

#### `DistractionPatterns.tsx`
- Timeline bar chart (distractions by day of week)
- Peak distraction time analysis
- Pattern detection ("Tuesday 2-4pm is chaos window")

#### `DistractionInsights.tsx`
- Recommendations in glass cards
- Actionable suggestions ("Mute Slack 9-11am")
- Experiment tracking ("Try this for 1 week")

#### `index.ts`
- Export all components

### 2. Update Analytics Page
Modify `src/routes/assistant/analytics.tsx` to include distraction section.

## Component Architecture

```
analytics.tsx
  DistractionSection (new section on analytics page)
    DistractionStats (pie chart)
    DistractionPatterns (bar chart + analysis)
    DistractionInsights (recommendations)

QuickLogButton (floating, global)
  DistractionLogModal (modal dialog)
```

## Data Flow
- Use existing `useDistractions` hook from `@/lib/assistant/hooks/`
- Hook provides: logDistraction, getStats, getTodayDistractions, etc.
- DistractionStats type already defined in storage/types.ts

## UI/Styling
- Cyberpunk aesthetic with neon colors per source
- Glass card styling for insights
- Recharts with custom theming
- Subtle pulse animation on quick log button
- Source icons with glow effects

## Color Mapping for Sources
- Slack: cyan-500 (MessageSquare)
- Email: blue-500 (Mail)
- Meeting: orange-500 (Users)
- Coworker: purple-500 (User)
- Hunger: amber-500 (Coffee)
- Other: gray-500 (AlertCircle)
