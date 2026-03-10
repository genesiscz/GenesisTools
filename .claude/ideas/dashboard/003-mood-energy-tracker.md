# 003 - Mood & Energy Tracker

## Overview
A lightweight mood and energy check-in system that allows users to quickly log their emotional state and energy levels throughout the day. Provides pattern recognition, identifies optimal times of day, detects mood/energy triggers, and correlates with other tracked data (sleep, nutrition, activity). Emphasizes quick, frequent check-ins without friction.

## Purpose & Goals
- Establish awareness of mood and energy patterns throughout the day
- Identify optimal times for different types of work (creative, analytical, social)
- Detect triggers: "Social time energizes you" or "Afternoon slumps are consistent"
- Correlate mood/energy with other health metrics
- Support mental health through pattern visibility and exportable data for therapists/coaches
- Enable accountability partners to share emotional check-ins

## Key User Flows

### 1. Quick Mood/Energy Check-In
- User taps check-in button (can be from any page via floating action)
- Quick entry modal appears:
  - Mood scale: 5-point emoji scale (😢 to 😄) or 1-10 numeric
  - Energy scale: 5-point scale (🔋 depleted to 🔋🔋🔋 energized)
  - Optional note: What's affecting this? ("Hungry", "Slept well", "Social time")
  - Optional context tags: location, activity, social setting
- Submit in 20 seconds
- Gentle reminder notifications (3x daily at configurable times)

### 2. Daily Mood/Energy Timeline
- View all check-ins for today as timeline
- Graph showing mood and energy curves throughout day
- Each check-in shows timestamp, score, optional note
- Patterns visible: mood dipped at 3pm both days, energy rose after lunch

### 3. Weekly Patterns Dashboard
- 7-day grid showing mood and energy for each time checked in
- Heatmap: which times of day are you most energized? Mood peaks?
- Average mood/energy by hour of day
- "You check in at: 7am (avg mood: 3.2), 12pm (avg mood: 4.1), 5pm (avg mood: 3.8)"
- Best/worst mood times highlighted

### 4. Mood/Energy Insights
- "Your mornings are best: avg mood 4.2/5 before noon"
- "Afternoon slump detected: 2-4pm mood averages 2.8/5"
- "Social interactions energize you: +1.5 energy after social events"
- "You're most creative on high-energy mornings"
- "Monday mornings: 30% lower mood than other days"
- Correlation with sleep: "After 6-hour sleep nights, mood is 1.2 points lower"

### 5. Mood History & Export
- 30/90 day mood overview (see trends over weeks)
- Exportable mood data for therapists or personal tracking
- Annotation support: "Started new medication", "Big project deadline"
- Mood trend line: improving, declining, stable?

## Data Model

```typescript
interface MoodEnergyCheckIn {
  id: string
  userId: string
  dateTime: DateTime
  mood: 1 | 2 | 3 | 4 | 5 // Or 1-10 if using numeric
  energy: 1 | 2 | 3 | 4 | 5 // Or 1-10
  notes?: string // "Slept well", "Hungry", "Social time was great"

  context?: {
    location?: string // "home", "office", "gym", "coffee shop"
    activity?: string // "working", "exercising", "socializing", "resting"
    socialSetting?: string // "alone", "with partner", "with friends", "group"
    triggers?: string[] // Tags for what influenced mood
  }

  // For shared check-ins
  sharedWith?: string[] // userId array if shared with accountability partners

  createdAt: DateTime
  updatedAt: DateTime
}

interface MoodGoal {
  id: string
  userId: string
  targetMood: number // Aim for average mood of 3.5+ per day
  createdAt: DateTime
}

interface MoodExport {
  userId: string
  startDate: Date
  endDate: Date
  checkIns: MoodEnergyCheckIn[]
  summary: {
    averageMood: number
    averageEnergy: number
    moodTrend: "improving" | "declining" | "stable"
    bestTime: string // "7am-9am"
    worstTime: string // "2pm-4pm"
  }
}
```

## UI Components

### Quick Check-In Card
- Floating action button with emoji or heart icon
- Modal that slides up with:
  - Mood scale with visual emojis (😢 😞 😐 🙂 😄)
  - Energy scale with battery icons (🔴 🟡 🟢 🔋 🔋🔋)
  - Optional text input: "What's affecting this?"
  - Optional context selector (dropdown or tags)
  - Submit button
- Can be dismissed quickly without logging (optional reminder later)

### Mood Dashboard Page
- Tabs: Daily | Weekly | Monthly | Patterns | Export
- Daily tab:
  - Large mood/energy gauges showing current state
  - Timeline of all check-ins today
  - Each check-in shows score and note
  - Quick add button for next check-in
  - Estimated best time for focus work based on today's pattern
- Weekly tab:
  - 7-day grid with mood/energy scores
  - Heatmap colors (red=low mood, green=high mood)
  - Time-of-day patterns: which hours have best mood?
  - Average scores by time slot
  - Mood/energy curves overlaid as line graphs
- Monthly tab:
  - 30-day calendar heatmap (green days vs red days)
  - Trend line showing if improving/declining
  - Week-over-week comparison
  - Best/worst weeks
- Patterns tab:
  - "Your best times": 7-9am, 10am-12pm (mood 4.1, energy 4.3)
  - "Your tough times": 2-4pm (mood 2.8, energy 2.4)
  - "Triggers": "Social interactions boost energy +1.5"
  - "Days of week": "Mondays are 20% lower mood"
  - Correlation cards with other metrics (sleep impact, exercise boost, etc.)
- Export tab:
  - Date range selector
  - Download as PDF, CSV, or JSON
  - Summary statistics
  - Mood trends over selected period

### Mood Widget
- Dashboard home shows "Current mood: 😊 4/5 energy: 🔋🔋 4/5"
- Weekly trend mini-chart
- "Your best time today: 10am"

### Shared Check-In Card (for Accountability Network)
- Shows partner's current mood if shared
- Both can see each other's mood trends
- Encourages: "Your partner just checked in—want to say hi?"

## Integration Points

**Sleep Tracker Integration:**
- Show sleep quality vs. mood/energy next day
- "After 7+ hour sleep: avg mood 4.1/5"
- "After <6 hour sleep: avg mood 2.8/5"
- Recommendation: "Better sleep → Better mood"

**Nutrition Tracker Integration:**
- "Caffeine after 2pm correlates with lower evening mood"
- "Skipping breakfast days: afternoon mood -1.5 points"
- "High protein breakfast: morning mood +0.8 points"

**Activity Log Integration:**
- Exercise correlation: "Exercise days: mood +0.9"
- "Rest days: mood -0.5"
- Social activity: "Days with social time: energy +1.2"

**Accountability Network:**
- Share mood check-ins with partner
- Partner can see trends, offer support
- Shared goal: "Let's both maintain 3.5+ mood average"
- Check-in reminders from partner

**Therapist/Coach Export:**
- Provide mood history for mental health professionals
- Helps identify patterns with professional guidance

## Success Criteria

- Users can check in mood/energy in <20 seconds
- System identifies 2-3 clear daily mood patterns within 1 week
- Correlations with sleep/nutrition visible after 2 weeks
- Mood trends clearly show improvement/decline over time
- Exportable data useful for therapists or personal analysis

## Technical Considerations

- Background notifications for reminder check-ins (configurable frequency)
- Quick check-in should not require navigation
- Mood data visualization (line graphs, heatmaps)
- Correlation calculations with statistical significance testing
- Time-of-day analysis using hour-based bucketing
- Timezone-aware timestamps

## Error Handling

- Missing check-ins: no penalty, just data gaps
- Future check-ins: prevent with validation
- Out of range scores: validate 1-5 or 1-10 range
- Duplicate same-minute check-ins: allow (user might be refining entry)
- Missing context: optional, don't require

## Privacy & Sharing

- Mood data highly private by default
- Sharing only with explicit consent
- Shared data limited (can control what partner sees)
- Export requires confirmation of intended recipient
- No AI analysis of mood without opt-in

## Related Features

- Central hub for all health metrics (sleep, nutrition, activity, mood)
- Correlations drive insights in other features
- Feeds Accountability Network shared goals
- Supports Relationship Calendar (check-in with people when your mood is good)

## Open Questions

1. Should we integrate with wearables (Apple Health, Fitbit) for heart rate/sleep data?
2. How granular should context options be? (Free text vs. preset tags)
3. Should we offer guided mood reflection prompts?
4. What's the optimal frequency for reminders? (Too many = annoying)
5. Should mood data be shareable with healthcare providers?
