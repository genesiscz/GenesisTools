# 011 - Creative Metrics

## Overview
A creative productivity tracker that measures output across various creative disciplines: writing (words), design (projects), music (tracks), video (hours), photography (photos), art (pieces), etc. Provides streak tracking, monthly/annual productivity metrics, burnout detection, creative flow visualization, and integration with portfolio and accountability network for motivation and accountability.

## Purpose & Goals
- Track creative output in measurable ways
- Celebrate consistent creative practice and productivity
- Detect burnout patterns (declining productivity, creative blocks)
- Maintain momentum through visible progress
- Support creative goals (write a novel, produce an album, etc.)
- Enable accountability with creative partners
- Show creative evolution over time
- Provide motivation through streaks and milestones

## Key User Flows

### 1. Log Creative Output
- User logs creative work as it's completed
- Quick entry:
  - Creative type (writing, design, music, video, photography, art, etc.)
  - Amount/metric (words, projects, tracks, hours, photos, pieces)
  - Title/description (optional)
  - Notes (mood, tools used, inspiration)
  - Time spent (optional)
- Can be quick (tags + number) or detailed (full metadata)
- Entries appear in activity log and timeline

### 2. Creative Dashboard Overview
- Monthly creative output at a glance
- Total words written, designs completed, etc.
- "This month: 12,000 words written, 3 designs completed"
- Daily streak: "15 days of consistent creative output"
- Compared to last month: "+20% more productive"

### 3. Creative by Type
- Separate metrics for each creative discipline
- Writing: "2,000 words/day average, 40,000 words this month"
- Design: "3 projects completed, average 2 days per project"
- Music: "4 tracks produced, 16 hours spent"
- Photography: "200 photos taken, 12 edited and posted"
- Video: "3 videos edited, 8 hours of content created"
- Art: "5 pieces completed, mixed media focus"

### 4. Streaks & Consistency
- Consecutive days of creative output
- "15-day creative streak 🔥"
- Streak reset tracking (when was last break?)
- Motivation: "Keep the streak alive!"
- Historical streaks (longest, this year, etc.)

### 5. Creative Flow Detection
- Identify most productive times of day
- "You write most between 10am-1pm"
- "Design momentum peaks on Wednesday afternoons"
- Suggest optimal creative times
- Track energy/mood during creative work
- Detect burnout: declining output, longer hours for same output

### 6. Creative Goals
- "Write 50,000 words this month (NaNoWiMo)"
- "Complete 5 design projects"
- "Finish music album (12 tracks)"
- Progress toward goals displayed prominently
- Pacing suggestions: "3,333 words/day to hit goal"
- Countdown to deadline

### 7. Creative Milestones
- Words written: "100k lifetime", "Wrote my first novel"
- Projects: "Completed 50 design projects"
- Songs: "Produced 20 tracks"
- Streak milestones: "30-day creative streak"
- Time invested: "1,000 hours total creative practice"

### 8. Burnout Detection & Rest Days
- System notices: "You've been averaging 6 hours/day. Time for a break?"
- Track quality alongside quantity: "Fewer hours but higher quality"
- Rest days are celebrated: "You took a well-deserved break"
- No guilt culture: creative rest is productive
- Suggestions for refreshing creativity

## Data Model

```typescript
interface CreativeSession {
  id: string
  userId: string
  creativeType: CreativeType // "writing", "design", "music", "video", "photography", "art"
  date: DateTime
  dateLogged: DateTime // When user logged this

  // Metrics (vary by type)
  metricsData: {
    type: CreativeType
    value: number // 2000 words, 1 project, 3 hours, 50 photos, etc.
    unit: string // "words", "projects", "hours", "photos", etc.
  }

  timeSpent?: number // in minutes
  title?: string // "Chapter 5 - The Journey", "Mobile app redesign"
  description?: string
  notes?: string // mood, tools, inspiration

  // Session metadata
  mood?: 1 | 2 | 3 | 4 | 5 // How did you feel?
  energy?: 1 | 2 | 3 | 4 | 5 // Creative energy level
  tools?: string[] // Software used: ["Figma", "Procreate", "Logic Pro"]
  tags?: string[] // Project tags, styles, genres

  // Quality rating
  qualityRating?: 1 | 2 | 3 | 4 | 5 // How satisfied?

  linkedProject?: string // Portfolio projectId if portfolio integration

  createdAt: DateTime
  updatedAt: DateTime
}

type CreativeType = "writing" | "design" | "music" | "video" | "photography" | "art" | "other"

interface CreativeMetrics {
  userId: string
  period: "day" | "week" | "month" | "year" | "alltime"
  creativeType: CreativeType
  totalOutput: number
  totalTimeSpent: number // minutes
  sessionCount: number
  averageSessionLength: number
  averageQuality: number
  bestDay: DateTime
  bestSession: CreativeSession
}

interface CreativeStreak {
  userId: string
  currentStreakDays: number
  longestStreakDays: number
  currentStreakStart: DateTime
  longestStreakStart: DateTime
  longestStreakEnd: DateTime
  streakBroken: boolean
}

interface CreativeGoal {
  id: string
  userId: string
  creativeType: CreativeType
  goalDescription: string // "Write 50,000 words"
  targetValue: number
  currentValue: number // auto-synced
  deadline: DateTime
  status: "active" | "completed" | "failed"
  suggestedDailyPace: number
  createdAt: DateTime
}

interface BurnoutIndicator {
  userId: string
  averageHoursPerDay: number
  qualityTrend: "improving" | "stable" | "declining"
  streakStatus: "active" | "broken_recently"
  lastBreakDate?: DateTime
  daysSinceBreak: number
  burnoutRisk: "low" | "medium" | "high"
  recommendations: string[]
  lastUpdated: DateTime
}
```

## UI Components

### Quick Creative Log Card
- Floating action button or quick-add from any page
- Minimal form:
  - Creative type selector (dropdown or tabs)
  - Amount input (words, projects, etc.)
  - Title input (optional)
  - Time spent input (optional)
  - Notes textarea (optional)
  - Submit button
- Takes <1 minute to log
- Can be logged retroactively

### Creative Dashboard Page
- Tabs: Overview | By Type | Streaks | Goals | Analysis | Milestones
- Overview tab:
  - Large display: "This month: 12,000 words | 3 designs | 8 hours music"
  - Sparkline showing daily output this month
  - Current streak: "15 days 🔥"
  - Compared to last month: "+20% more productive"
  - Mood/energy breakdown
  - Quality trend (is work getting better or worse?)
  - Quick log button
- By Type tab:
  - Each creative discipline gets its own section
  - Writing:
    - Words written: "2,000 words/day average"
    - Monthly total: "40,000 words"
    - Best writing time: "10am-1pm"
    - Recent sessions list
  - Design: projects, average time per project, best design day
  - Music: tracks produced, average track length, genres used
  - Photography: photos taken/edited, collection breakdown
  - Video: video hours, number of projects, average length
  - Art: pieces created, mediums used, collection growth
- Streaks tab:
  - Current streak display: "15 consecutive days"
  - Streak calendar (heatmap showing consistent days)
  - Longest streak ever: "32 days"
  - Streak recovery: "Broke streak 2 weeks ago, rebuild in progress"
  - Motivational messages
- Goals tab:
  - Active creative goals with progress
  - "Write 50,000 words: 35,000/50,000 (70%)"
  - Deadline countdown
  - Pacing suggestion: "Write 3,333 words/day to hit goal"
  - Time remaining
  - Completed goals (archive)
- Analysis tab:
  - Most productive times (heatmap by hour of day)
  - Best days of week for creativity
  - Mood vs. output correlation
  - Quality trend (improving/stable/declining)
  - Seasonal patterns (monthly breakdown)
  - Burnout risk assessment
- Milestones tab:
  - Recent milestone celebrations
  - Lifetime metrics: "100k words written", "50 designs completed"
  - Streak achievements: "30-day streak"
  - Annual summary: "Wrote 200k words this year"

### Creative Type Widget
- Shows selected creative type's metrics
- "Writing: 40,000 words this month"
- Sparkline for last 30 days
- Streak indicator
- Quick log button

### Streak Visualization
- Calendar heatmap showing consistency
- Green = creative session that day
- Darker green = longer/more productive session
- Gray = no session
- Current streak highlighted
- Motivational phrase: "Keep it up!" "You're on fire!"

### Creative Goal Card
- Goal title and type
- Large progress bar
- Current value / target
- Days remaining
- Daily pace needed
- "You need 3,333 words/day to finish"
- Completion estimate

### Burnout Detection Alert
- If system detects burnout risk:
  - "You've been working 6+ hours daily for 2 weeks"
  - "Time for a creative break?"
  - Suggestion: "Rest days are productive too"
- Option to plan a break day
- Normalize rest as part of creative process

### Quality Analysis
- Graph showing quality ratings over time
- Correlation with hours spent (diminishing returns?)
- Best quality work times
- Suggestions: "Your best work is 2-3 hour sessions"

### Milestones Archive
- Chronological list of all milestones achieved
- "200k words written - March 2024"
- "Completed 50 design projects - June 2024"
- "30-day creative streak - February 2025"
- Shareable milestone cards

## Integration Points

**Portfolio System:**
- Creative projects auto-appear in portfolio
- "Completed design project: X" = portfolio project
- Creative metrics show in portfolio: "200 designs completed, 8,000 hours"
- Link creative goals to portfolio milestones

**Skill Leveling System:**
- Creative practice counts as skill advancement
- "Design skill: 50 projects → Advanced level"
- "Writing skill: 200k words → Advanced level"
- Tool proficiency: "Figma: 8 projects → Expert"

**Accountability Network:**
- Share creative goals with accountability partner
- "Let's both write 50k words this month"
- Partner sees progress (motivational)
- Shared creative challenges: "Produce a song together"
- Celebrate milestones together

**Activity Log:**
- Creative sessions appear as major activities
- "Wrote 5,000 words", "Designed new app mockup"
- Timeline shows creative productivity
- Correlated with mood/energy

**Mood & Energy Tracker:**
- Log mood before/after creative session
- Creativity can energize or drain
- Suggest creative time when mood/energy is good
- Correlation: "Creative time improves your mood"

## Success Criteria

- Creative logging takes <1 minute
- Streaks are motivating without guilt on breaks
- Output metrics are accurate and clear
- Goals feel achievable and trackable
- Burnout is detected and addressed supportively
- Users celebrate creative milestones
- Accountability partners keep each other motivated

## Technical Considerations

- Flexible metrics system (words, projects, hours, photos, etc.)
- Streak calculations and reset logic
- Quality rating aggregation
- Burnout detection algorithm
- Productivity trend analysis
- Time zone aware date boundaries
- Historical data for annual reviews

## Error Handling

- Invalid output amounts: validate positive numbers
- Invalid creative types: suggest existing types
- Duplicate entries same day: allowed (multiple sessions)
- Quality ratings optional
- Time spent optional (can be empty)

## Motivational Principles

- Celebrate consistency over quantity
- Rest days are encouraged, not penalized
- Quality matters more than volume long-term
- Streaks are motivating but not mandatory
- Burnout recognition and prevention important
- Share milestones, not compare raw numbers

## Privacy Considerations

- Creative work details shareable (with control)
- Don't expose full creative output to public
- Can choose what appears in portfolio
- Quality ratings are personal feedback only

## Creative Tools Integration (Future)

- Integration with writing software (Word, Notion, Scrivener)
- Design app integration (Figma, Adobe Creative Cloud)
- Music DAW integration (Logic, Ableton, FL Studio)
- Auto-logging creative output from these apps

## Related Features

- Portfolio: showcases creative work
- Skill Leveling: levels up based on creative practice
- Accountability Network: shared creative goals
- Activity Log: creative sessions in timeline
- Mood Tracker: mood impact of creativity

## Open Questions

1. Should we integrate with creative apps for auto-logging?
2. Should we allow collaborative creative tracking?
3. Should we provide writing/design prompts for inspiration?
4. Should we track creative income earned?
5. Should we show collaboration on projects?
