# 001 - Sleep & Recovery Dashboard

## Overview
A comprehensive sleep tracking and recovery analytics system that logs sleep sessions, analyzes patterns, and correlates sleep quality with energy, mood, and performance metrics. Integrates seamlessly with the existing Timer to record sleep durations and provides data-driven insights about optimal sleep windows and recovery needs.

## Purpose & Goals
- Enable users to understand their sleep patterns and how sleep impacts daily performance
- Identify optimal sleep duration and timing for individual users
- Detect correlation between sleep and other tracked metrics (mood, energy, productivity)
- Provide actionable insights: "You perform best after 7+ hours" or "Weekend sleep debt affects Monday mood"
- Help users establish consistent sleep routines through pattern recognition

## Key User Flows

### 1. Logging Sleep Session
- User goes to sleep, starts Timer with "Sleep" mode
- Timer records duration automatically
- Upon waking, user logs quality rating (1-5 scale or emoji) + optional notes ("Woke up 3x", "Vivid dreams")
- System stores: date, start time, end time, duration, quality rating, notes
- Optional: manually input historical sleep data

### 2. Viewing Sleep Analytics
- Weekly/monthly sleep dashboard showing:
  - Sleep duration trend line (avg hours per night)
  - Quality distribution (pie chart of 1-5 ratings)
  - Sleep schedule heatmap (when you typically sleep)
  - Calendar view with sleep dots color-coded by quality
- Insights panel showing patterns detected

### 3. Correlation Analysis
- Cross-tab with mood tracker: "Days after 6-hour sleep, mood is 2.1/5 lower"
- Cross-tab with energy: "You report highest energy after 7-8 hour sleeps"
- Cross-tab with productivity: "Focus time is 40% longer after quality sleep"
- Suggests causation: "Try aiming for 7.5 hours tonight to improve tomorrow's mood"

### 4. Sleep Goals
- Set target sleep duration (e.g., "7 hours per night")
- Goal progress bar showing weekly average vs. target
- "You've hit your sleep goal 4/7 nights this week"
- Alerts for sleep debt: "You're 3 hours short this week"

## Data Model

```typescript
interface SleepSession {
  id: string
  userId: string
  date: Date // Date of sleep (night it was)
  startTime: DateTime // When fell asleep
  endTime: DateTime // When woke up
  duration: number // In minutes
  quality: 1 | 2 | 3 | 4 | 5 // Quality rating
  notes?: string // "Woke up 3x", "Took melatonin", etc.
  sleepStages?: {
    // Optional: if integrating with device data later
    light: number
    deep: number
    rem: number
  }
  tags?: string[] // ["late-night", "stressful-day", "exercise"]
  createdAt: DateTime
  updatedAt: DateTime
}

interface SleepGoal {
  id: string
  userId: string
  targetHours: number // e.g., 7.5
  createdAt: DateTime
}
```

## UI Components

### Sleep Log Card
- Date selector (calendar or date picker)
- Duration input (uses Timer data if available)
- Quality slider (1-5 emoji or numeric)
- Notes textarea
- Save button

### Sleep Dashboard Page
- Header: "Sleep & Recovery" with quick stats (avg this week, last night quality)
- Tabs: Overview | Analytics | Goals | Insights
- Overview tab:
  - Large trend line chart (7-day rolling average)
  - Sleep schedule heatmap (24-hour view showing when user typically sleeps)
  - Last 7 nights calendar with quality indicators
- Analytics tab:
  - Quality distribution pie chart
  - Duration histogram (how many nights at 6h, 7h, 8h, etc.)
  - Best/worst sleep nights highlighted
- Goals tab:
  - Current goal display with weekly progress bar
  - Goal history (past goals set)
  - Suggestion engine: "Based on your data, 7.5 hours gives best mood next day"

### Insights Panel
- "This week, 3/7 nights above target"
- "Quality improved 15% since goal was set"
- "Your ideal sleep time: 7:00 PM - 6:00 AM"
- "Monday mornings: 20% lower mood after weekend sleep debt"

## Integration Points

**Timer Integration:**
- Timer has "Sleep" mode that auto-records to sleep tracker
- After timer stops, prompts for quality rating
- Seamless workflow: Timer → Sleep Quality → Auto-logged

**Mood Tracker Integration:**
- Can view mood graph overlaid on sleep graph
- Shows "Correlation: High sleep quality → High mood next day"
- Recommendation: "Aim for quality sleep tonight to improve mood tomorrow"

**Activity Log Integration:**
- Sleep sessions appear in activity timeline
- Can correlate previous day's activities with that night's sleep
- "Heavy exercise yesterday → Deeper sleep, better quality"

**Dashboard Home Integration:**
- Sleep widget on main dashboard: "Last night: 6.5h, Quality: 4/5"
- Weekly sleep goal progress ring
- "1 more hour this week to hit your goal"

## Success Criteria

- Users can log sleep in <30 seconds (quick quality rating)
- System identifies 2-3 actionable patterns within 2 weeks of data
- Insights correlate sleep with other metrics correctly
- Weekly sleep trend clearly visible
- Users can set and track sleep goals effectively

## Technical Considerations

- LocalStorage for session data (user preference for privacy)
- Indexed DB for larger datasets (months of sleep data)
- Correlation calculations should be debounced (weekly updates)
- Sleep schedule heatmap requires date math and visualization library (chart.js or recharts)
- Quality insights require statistical analysis of trends

## Error Handling

- Invalid dates handled gracefully
- Future sleep dates prevented
- Duplicate entries on same night: allow override with confirmation
- Missing quality ratings: allow logging duration alone, quality optional
- Timezone awareness for accurate date boundaries

## Related Features

- This feeds into Mood & Energy Tracker for correlation
- Integrates with Health Dashboard concept
- Could connect to Accountability Network (shared sleep goals with partners)

## Open Questions

1. Should we collect sleep stages (light/deep/REM) data from wearables later?
2. Should there be sleep debt tracking across multiple weeks?
3. How granular should correlation insights be?
