# 005 - Accountability Network

## Overview
A collaborative goal-tracking system that enables users to share goals with friends and accountability partners. Provides shared progress visibility, check-in messaging, milestone celebrations, and cross-goal insights. This is the connective tissue that links Health, Finance, Career, and Creative goals across multiple users in a supportive community.

## Purpose & Goals
- Create accountability partnerships for shared commitments
- Enable transparent progress tracking without judgment
- Foster supportive community around personal growth
- Allow flexible goal types: fitness, savings, creative, career, health
- Celebrate milestones and achievements together
- Automate progress syncing from other dashboard features (sleep goals, savings goals, etc.)

## Key User Flows

### 1. Create & Share Goal
- User creates goal: "Run 20 miles this week" or "Save $500 for vacation"
- Selects goal type (fitness, savings, creative, career, health, custom)
- Adds target and deadline
- Invites accountability partner (by email or username)
- Partner receives invitation and accepts/declines
- Both see real-time progress once partner accepts

### 2. Auto-Sync from Other Features
- Savings goal created in Spending Tracker automatically appears in Accountability Network
- Sleep goal from Sleep Tracker shared with partner
- Creative output goals from Creative Metrics synced
- Skill goals from Skill Leveling synced
- Partner sees progress without user manually updating

### 3. Check-In & Messaging
- Partner sends check-in message: "How's the project going?"
- User replies with progress update
- Messages visible only to partners on that goal
- Ability to set check-in frequency (daily, weekly, etc.)
- Optional: video/voice message support

### 4. Progress Dashboard
- View all shared goals and partners
- See partner's current progress on each goal
- Timeline of goal achievements and milestones
- Partner goals and your progress on them (if shared)
- Celebration notifications when milestones hit

### 5. Goal Challenges
- Create 2-week or monthly challenges with friends
- "Let's all exercise 3x/week for the next month"
- Group leaderboard showing who's leading
- Friendly competition with praise, not criticism
- Group chat for encouragement

### 6. Milestone Celebrations
- Automatic celebration when goals hit 25%, 50%, 75%, 100%
- Confetti animations, achievement badges
- Ability to share milestone with other friends
- "I just saved $500 for my vacation!" - Share button
- Monthly achievements digest email

## Data Model

```typescript
interface SharedGoal {
  id: string
  ownerId: string // User who created goal
  partnerId: string // Partner user
  goalType: "fitness" | "savings" | "creative" | "career" | "health" | "custom"
  title: string // "Run 20 miles this week"
  description?: string
  targetValue: number // Miles, dollars, count, etc.
  currentValue: number // Auto-synced from other features when possible
  unit: string // "miles", "dollars", "pages written"
  deadline: DateTime
  status: "active" | "completed" | "failed" | "abandoned"
  sourceFeature?: string // "sleep_tracker", "spending_tracker", etc.

  createdAt: DateTime
  completedAt?: DateTime
}

interface GoalCheckIn {
  id: string
  goalId: string
  fromUserId: string // Who sent this check-in
  message: string
  progress?: number // Optional updated progress
  confidence?: 1 | 2 | 3 | 4 | 5 // How confident are they in achieving goal
  createdAt: DateTime
}

interface GoalChallenge {
  id: string
  creatorId: string
  title: string // "Exercise 3x/week Challenge"
  description: string
  durationDays: number // 14 or 30 days
  metric: string // "exercise_sessions", "words_written", etc.
  targetPerPerson: number // Each person needs 3 sessions
  participants: string[] // Array of userIds
  leaderboard: {
    userId: string
    currentValue: number
    rank: number
  }[]
  status: "active" | "completed"
  createdAt: DateTime
  endsAt: DateTime
}

interface AccountabilityPartnership {
  id: string
  users: [string, string] // Pair of userIds
  goals: string[] // Array of goalIds they share
  totalGoalsCompleted: number
  totalCheckIns: number
  isActive: boolean
  createdAt: DateTime
}
```

## UI Components

### Goal Creation Modal
- Minimal form to create shared goal
- Fields:
  - Goal title and description
  - Goal type selector (dropdown)
  - Target value and unit
  - Deadline (date picker)
  - Partner selector (autocomplete from contacts)
  - Auto-sync option (if syncing from another feature)
  - Create button

### Accountability Dashboard Page
- Tabs: My Goals | Partnerships | Challenges | Milestones
- My Goals tab:
  - List of all shared goals
  - Each goal shows:
    - Title, deadline, and progress bar
    - Current value vs. target ("47/50 miles")
    - Partner name and avatar
    - Latest check-in message
    - "Check in" button
  - Grouped by status (active, completed, in-progress)
- Partnerships tab:
  - List of accountability partners
  - Each shows:
    - Partner name/avatar
    - Number of shared goals
    - Total milestones hit together
    - Total check-ins
    - "View all goals" button
    - "Send message" button
  - Action to invite new partner
- Challenges tab:
  - Active challenges user is in
  - Leaderboard showing current standings
  - User's position and progress
  - Remaining time
  - Group chat for challenge
  - Option to create new challenge
- Milestones tab:
  - Recent goal completions (yours and partners')
  - Celebration cards with confetti animation
  - Shareable milestone (can share with other friends)
  - Archive of past achievements

### Goal Check-In Modal
- Simple message composer
- Optional confidence slider (1-5)
- Optional progress update input
- Send button
- Shows conversation history with partner below

### Shared Goal Card
- Goal title and partner name
- Large progress bar with percentage
- Current value / Target value
- Days remaining
- Latest message preview
- Quick action buttons: Check-in, Message, View details

### Milestone Celebration
- Full-screen celebration modal when goal hits milestone
- Confetti animation
- Achievement badge
- "Share this milestone" button
- Partner notification: "Your partner hit 50%! 🎉"

### Leaderboard (for Challenges)
- Ranked list of challenge participants
- Current value per person
- Leader highlighted with medal 🥇
- Green arrows showing who moved up since yesterday
- Bottom shows: "You're 3rd place, 5 miles behind the leader!"

## Integration Points

**Sleep Tracker:**
- Sleep goal syncs automatically to Accountability Network
- Partner sees your sleep progress weekly
- Check-in: "How'd you sleep? On track for your goal?"

**Spending Tracker:**
- Savings goals automatically appear in shared goals
- Partner sees progress: "Saved $420/$500"
- Group challenge: "Save $100 together this week"

**Mood Tracker:**
- Optional: Share mood check-in frequency goal with partner
- "Let's both do daily mood check-ins for a month"
- See partner's mood trends (if they share)

**Creative Metrics:**
- Creative output goals synced
- "We both committed to writing 10k words this month"
- Leaderboard: who's hitting targets faster?

**Skill Leveling System:**
- Share skill development goals
- "Let's both reach Intermediate in Python"
- Partner sees your progress

**Relationship Calendar:**
- Accountability partner appears on calendar
- Auto-sync check-in dates
- Celebration reminders for partner achievements

## Success Criteria

- Goal creation: <1 minute including partner invitation
- Progress auto-syncs from other features seamlessly
- Check-in process is lightweight and encouraging
- Milestones feel celebratory, not pressuring
- Partnerships motivate without creating stress
- Users see partner progress in near real-time

## Technical Considerations

- Real-time progress updates (WebSocket or polling)
- Notification system for check-in requests and milestones
- Leaderboard ranking calculations (efficient sorting)
- Auto-sync from other features via shared user ID
- Messaging system with optional encryption
- Activity feed for partnership activity

## Error Handling

- Partner invitation already exists: warn user
- Partner declines invitation: graceful notification
- Goal achieved but partner absent: still celebrate
- Partner data unavailable (offline): show last-known value
- Invalid progress values: sanitize and warn user

## Privacy Considerations

- Only shared goal data visible to partner (other data private)
- Shared data limited to goal progress only
- Can unshare goal at any time
- Partner cannot see raw data unless explicitly shared
- Achievements can be kept private or shared publicly
- All partnerships start with explicit acceptance

## Feedback & Encouragement System

- Messages are supportive, never judgmental
- UI emphasizes "you're doing great" not "you're behind"
- Leaderboard shows progress, not failure
- Failed goals archived but not highlighted negatively
- Celebrate effort, not just results

## Related Features

- Connective feature linking Sleep, Nutrition, Mood, Spending, Creative, Skills
- Each feature can create/sync goals to Accountability Network
- Enables cross-feature insights: "Social time + sleep → Better mood next day"

## Open Questions

1. Should partners have asymmetric access (one sees all, one private)?
2. How to handle goal failure gracefully?
3. Should we gamify with badges/achievements?
4. Video/voice message support or text-only initially?
5. Public vs. private challenge leaderboards?
