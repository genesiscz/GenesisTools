# 002 - Assistant Phase 1: Detailed Design (Context, Deadlines, Celebrations)

## Phase 1 Overview

**Three core features that solve immediate pain:**

1. **Context Parking Lot** - When switching tasks, quick-save your thinking. Auto-recall when you return. Solves knowledge loss from context switching.
2. **Deadline Hierarchy** - Classify tasks by urgency (critical/important/nice-to-have). Removes deadline anxiety and clarifies priorities.
3. **Completion Celebrations** - Big visual/audio feedback when you finish tasks. Builds motivation and streaks for ADHD brains.

**Plus:** Intelligent task prioritization that considers all three factors, configurable UX tiers, and GitHub integration (read: PRs/issues).

---

## Feature 1: Context Parking Lot

### Purpose
When you context-switch (which happens constantly), your working memory is lost. "I was debugging X, found a clue in Y..." → switch to meetings → switch back → forgot what you found.

The parking lot captures this micro-context so you can resume cleanly.

### User Flow

**Scenario: Developer working on Task A, gets interrupted**

1. Task A is "Fix auth timeout bug"
2. Developer realizes: "I was debugging middleware.ts, found timeout is 5s, need to check worker pool size next"
3. Developer clicks "Park my context" (or keyboard shortcut Cmd+P)
4. Modal appears:
   ```
   What were you working on?
   [Auto-filled: "Fix auth timeout bug"]

   What did you discover? What's next?
   [Text area]
   > "Debugging middleware.ts line 47. Found timeout is 5s, need to check worker pool size next. Also check database connection pooling."

   [Park it] [Cancel]
   ```
5. Developer parks context and switches to urgent meeting
6. Later, developer returns to "Fix auth timeout bug" task
7. Task detail view shows:
   ```
   ⏰ Last session: 2 hours ago
   📝 Where you left off:
   "Debugging middleware.ts line 47. Found timeout is 5s, need to check worker pool size next. Also check database connection pooling."

   [Continue] [Edit] [Clear]
   ```
8. Developer clicks "Continue", resumes exactly where they left off

### Data Model

```typescript
interface ContextParking {
  id: string
  userId: string
  taskId: string
  content: string // User's notes on where they left off
  codeContext?: {
    filePath?: string // "middleware.ts"
    lineNumber?: number // 47
    snippet?: string // Code snippet for reference
  }
  discoveryNotes?: string // What they found/learned
  nextSteps?: string // What to do when resuming
  timestamps: {
    parkedAt: DateTime
    resumedAt?: DateTime
    createdAt: DateTime
  }
  status: 'active' | 'resumed' | 'archived'
}
```

### UX Implementation Tiers

#### Tier 1: Dashboard Sidebar (Default)
```
Main Dashboard (Task detail view)
├─ Left Sidebar: Context Parking
│  ├─ "Last parked: 2 hours ago"
│  ├─ Text display: "Debugging middleware.ts..."
│  ├─ [Edit] [Clear] buttons
│  └─ [Park new context] button
│
├─ Center: Task details, description, checklist
│
└─ Right Sidebar: (Deadline info, below)
```

Quick-park button: Always visible in task header
- Keyboard shortcut: `Cmd+P` or `Ctrl+P`
- Opens minimal modal for quick capture

#### Tier 2: Smart Integration
```
When user clicks "I'm working on Task X":
├─ System auto-shows relevant sidebars
├─ If previous parking exists, highlights it
├─ Auto-saves parking periodically (every 5 mins of inactivity)
│  └─ Gentle: "Want to park your context before switching?" (not forced)
└─ If user opens different task, prompts: "Save context from previous task?"
```

#### Tier 3: Minimal Modals
```
User primarily works outside dashboard (code editor, etc.)
├─ Small modal when switching tasks (via dashboard):
│  ├─ "Switching from Task A to Task B. Park your context?"
│  ├─ Quick text input (single line or expand)
│  └─ [Park] [Skip] [Edit later]
│
└─ Auto-opens parking log when resuming task
   └─ Shows last context, option to clear or build on it
```

### Success Criteria

- Users remember where they left off (no "what was I doing?" moments)
- Parking takes <30 seconds
- Context is auto-surfaced when resuming (no digging through notes)
- 80% of context parkings are actually useful when resumed (vs. forgotten immediately)
- Users report 20% faster resume time (vs. having to retrace steps)

### Technical Implementation Notes

- Parking modal appears via keyboard shortcut or button click
- Supports rich text (markdown) for code snippets
- Optional GitHub integration: auto-link to PR/issue if user mentions them
- Can include file path + line number suggestions (optional)
- Search parking logs: "Find all context from last week about auth"

---

## Feature 2: Deadline Hierarchy

### Purpose
"I have 12 urgent things due." Which one actually blocks shipping? Which one is nice-to-have?

Deadline Hierarchy removes this ambiguity by classifying tasks into critical/important/nice-to-have with visual urgency indicators.

### User Flow

**Scenario: PM getting overwhelmed by deadline list**

1. PM opens task list, sees 12 tasks with due dates
2. PM feels paralyzed: "What matters most?"
3. PM clicks on a task to edit it
4. Task edit view shows:
   ```
   Task: "Update documentation for v2.0"
   Due: Friday, Jan 17

   How urgent is this?

   🔴 CRITICAL - Blocks shipping
       └─ If missed, product can't ship / customer is blocked / major incident

   🟠 IMPORTANT - Should hit deadline
       └─ If missed, causes downstream issues / rework needed / customer impact

   🟡 NICE-TO-HAVE - Flexible deadline
       └─ If slips, customer impact is minimal / can defer to next sprint

   [Classify as CRITICAL] [Classify as IMPORTANT] [Classify as NICE-TO-HAVE]
   ```
5. PM classifies it as IMPORTANT (documentation should ship with release, but product works without it)
6. Dashboard now shows tasks color-coded by urgency
7. Priority engine uses this to suggest "what's next"

### Data Model

```typescript
interface DeadlineHierarchy {
  taskId: string
  urgencyLevel: 'critical' | 'important' | 'nice-to-have'
  classificationReasoning?: string
  isShippingBlocker: boolean
  relatedCriticalTasks?: string[] // taskIds that depend on this
  updatedAt: DateTime
}
```

### UX Implementation Tiers

#### Tier 1: Dashboard Sidebar (Default)
```
Task Detail View
├─ Center: Task title, description
├─ Right Sidebar: Deadline & Urgency
│  ├─ Due date
│  ├─ Urgency classification (buttons or dropdown)
│  │  ├─ 🔴 CRITICAL
│  │  ├─ 🟠 IMPORTANT
│  │  └─ 🟡 NICE-TO-HAVE
│  ├─ Progress toward deadline (days remaining)
│  └─ "This task blocks: [list other tasks]"
│
└─ Quick filter on task list:
   ├─ [All] [🔴 Critical Only] [🔴+🟠 Critical+Important]
   └─ Smart default: "CRITICAL tasks highlighted, others lowkey"
```

#### Tier 2: Smart Integration
```
Task list view:
├─ Auto-sorts by urgency + deadline
├─ Color-codes rows: Red (critical), Orange (important), Yellow (nice)
├─ When user hovers task, shows: "This is CRITICAL. If missed, [reason]"
└─ Pinning: User can pin critical tasks to top
```

#### Tier 3: Minimal Modals
```
When user marks task complete:
├─ Modal: "Great! You completed [task name]"
├─ Shows urgency: "This was CRITICAL. You're on track! 🔥"
└─ Auto-advances to next critical task if any remain
```

### Smart Prioritization

The assistant uses deadline hierarchy to suggest next task:

```
Algorithm: NextTaskPriority = f(urgency, deadline, energy, context)

1. Filter by urgency:
   a. If any CRITICAL tasks exist: suggest highest-deadline CRITICAL
   b. Else if IMPORTANT exist: suggest highest-deadline IMPORTANT
   c. Else: suggest NICE-TO-HAVE by user's energy level

2. Tie-breaker (if multiple same urgency):
   a. User's configured preference: deadline < energy < context?
   b. Days until deadline (sooner = higher priority)
   c. Time already spent on task (long-stuck tasks get priority)

3. Contextual factors (if enabled):
   a. Same task as last session? (minimize switching)
   b. User's peak energy time? (match task to energy)
```

### Success Criteria

- PMs can classify 12 tasks' urgency in <5 minutes
- No paralysis: clear "do this first" recommendation
- 90% of classified tasks match team's actual priority
- Critical tasks never surprise with missed deadlines
- Users feel confident deadlines are set correctly

### Technical Notes

- Classification is quick: buttons, not text input
- Optional: Team-wide urgency standard (if async team feature exists)
- Search: "Show all critical tasks due this week"
- Reporting: "You hit 100% of critical deadlines this month" (motivation!)

---

## Feature 3: Completion Celebrations

### Purpose
ADHD brains need dopamine. Finishing a task should feel **rewarding**, not just another item crossed off.

Completion Celebrations make finishing tasks satisfying through visual/audio feedback, streaks, and badges.

### User Flow

**Scenario: Developer finishes a task**

1. Developer is working on "Fix auth timeout bug"
2. They mark task complete: [Mark complete] button
3. BOOM. Full-screen celebration:
   ```
   🎉 🎉 🎉

   YOU DID IT!
   "Fix auth timeout bug" ✅

   🔥 3-day focus streak!
   💪 You've completed 12 tasks this week
   ⏱️ You spent 2h 34m focused

   [Next task →] [Rest now] [Back to dashboard]
   ```
4. Confetti animation, celebratory sound (if enabled)
5. Task disappears from active list
6. Streak counter increments

### Micro-Celebrations

Beyond full-screen completions, celebrate smaller wins:

**Focus session milestone:**
```
User logs 25-minute focused work → gentle celebration
"Nice focus! Keep it up. 🎯"
```

**Streak achievement:**
```
User hits 7-day task completion streak
"🔥 7-DAY STREAK! You're on FIRE!"
```

**Badge earned:**
```
User completes 100 tasks total
"🏆 TASK MASTER - You've completed 100 tasks!"
```

### Data Model

```typescript
interface CompletionEvent {
  id: string
  userId: string
  taskId: string
  completionType: 'task-complete' | 'focus-session' | 'streak-milestone' | 'badge-earned'
  completedAt: DateTime
  celebrationShown: boolean
  metadata: {
    focusTimeSpent?: number // minutes
    taskUrgency?: string // 'critical', 'important', etc.
    currentStreak?: number // days
    totalTasksCompleted?: number
  }
}

interface Streak {
  userId: string
  currentStreakDays: number
  longestStreakDays: number
  lastTaskCompletionDate: DateTime
  streakResetDate?: DateTime // When current streak started
}

interface Badge {
  id: string
  userId: string
  badgeType: 'task-master-100' | 'focus-warrior-50' | 'streak-week' | 'streak-month' | 'consistency'
  earnedAt: DateTime
  displayName: string // "Task Master (100 tasks)"
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary'
}
```

### UX Implementation Tiers

#### Tier 1: Dashboard Celebration (Default)
```
Task List View
├─ User checks [✓] to mark complete
├─ Full-screen celebration overlay appears
│  ├─ Confetti animation (canvas-based, not annoying)
│  ├─ Sound effect (optional, configurable)
│  ├─ Text: "YOU DID IT!"
│  ├─ Stats: streak, focus time, tasks this week
│  ├─ Badges earned (if applicable)
│  └─ Buttons: [Next task] [Rest now] [Dashboard]
│
└─ After celebration: Task removed from active, added to completed
   └─ Weekly summary shows: "+1 task ✅ completed today"
```

#### Tier 2: Smart Integration
```
Celebration context-aware:
├─ Critical task completed: "CRITICAL TASK DONE! You're shipping on time! 🚀"
├─ Long-stuck task completed: "You finally crushed that blocker! 💪"
├─ During focus session: "25-min focus complete. Next task?" (gentle, not full celebration)
└─ Streak milestone: Full celebration + special badge
```

#### Tier 3: Minimal Celebration (Non-intrusive)
```
If user dislikes full-screen:
├─ Task disappears + subtle notification: "✅ Task completed! +1 day streak"
├─ Celebration info available in dashboard "Recent wins" section
└─ Streaks/badges visible in profile, not forced
```

### Celebration Customization

Users configure celebration style:

```
Settings → Celebrations
├─ [🎉 FULL PARTY] Big celebration, confetti, sound
├─ [✨ SUBTLE] Toast notification + streak update
├─ [🤫 SILENT] Task marked complete, stats in dashboard only
├─ Sound effects:
   ├─ Enabled / Disabled
   ├─ If enabled: [Chime] [Fanfare] [Retro game] [Custom audio URL]
└─ Confetti:
   ├─ Enabled / Disabled / Low-motion mode
```

### Weekly Review (Motivation)

Every Friday, show a quick review:

```
Weekly Review
├─ Tasks completed: 12 / 15 (80%)
├─ Focus streak: 5 days active
├─ Total focus time: 16 hours
├─ Best day: Thursday (4 tasks)
├─ Trend: ↑ 20% vs last week (AWESOME!)
├─ Badges earned this week: 1 new badge
└─ AI insight: "Your focus is best 10am-12pm. Try scheduling deep work then."
```

### Success Criteria

- 90%+ of users enjoy celebrations (vs. finding them annoying)
- ADHD users report 3x higher motivation to complete tasks
- Users develop consistent daily completion habit
- 30-day streak is achievable and motivating goal
- Celebrations don't distract from actually working

### Technical Implementation Notes

- Celebration animation via Canvas API (low-overhead)
- Sound effects: small audio files, user can upload custom
- Confetti respects prefers-reduced-motion accessibility setting
- Stats calculation: query completions for streak, count, dates
- Badge unlocking: rules-based system (100 tasks = badge, etc.)

---

## Integration: Smart Task Prioritization

Phase 1 features combine into intelligent "What should I do next?" system:

```
NextTaskRecommendation algorithm:

1. Filter active tasks
2. Sort by:
   a. Urgency (CRITICAL → IMPORTANT → NICE-TO-HAVE)
   b. Days until deadline (sooner = higher)
   c. Time spent (if stuck >4 hours, boost priority)
3. Adjust by:
   a. Context switching cost (if previous task same project, favor it)
   b. User's energy type & time of day (morning/afternoon/evening)
   c. User's configured weight: deadline > energy > context?
4. Surface with:
   a. Task context (parking lot info if resuming)
   b. Urgency label ("CRITICAL: Blocks shipping")
   c. Celebration motivation ("3-day streak going! Keep it up!")
```

### Dashboard "What Next?" Widget

```
Home Page Widget:

What should you do right now?

🔴 [Task title] - CRITICAL
Due tomorrow · ~2 hours · Blocks shipping

📝 Where you left off:
"Debugging middleware.ts line 47. Found timeout is 5s..."

🔥 3-day streak

[Start working] [Not now] [Details]
```

---

## GitHub Integration (Phase 1)

### Scope
- Read-only: Pull PRs and issues assigned to user
- Link tasks to PRs/issues
- Auto-populate task context from GitHub

### User Flow

1. User creates task in assistant
2. Optional: "Link to GitHub PR/issue"
3. Assistant fetches:
   - PR title, description, comments
   - Issue details, linked issues
   - Code review requests
   - CI status
4. Display in task context:
   ```
   Task: Fix auth timeout bug

   Linked GitHub: #1234 - Fix auth timeout (PR)
   Status: Awaiting review from @sarah
   CI: ✅ Passing
   ```

### Data Model

```typescript
interface GitHubLink {
  taskId: string
  repoUrl: string
  itemType: 'pull_request' | 'issue'
  itemNumber: number
  title: string
  status: string // 'open', 'merged', 'closed'
  lastSyncedAt: DateTime
}
```

### Technical Notes

- Use GitHub API (requires OAuth or personal token)
- Read-only initially (no push back to GitHub)
- Scheduled sync: refresh every 1 hour (or on-demand)
- Graceful degradation: if GitHub API fails, show cached data

---

## Phase 1 Implementation Roadmap

### Week 1: Core Infrastructure
- [ ] Task management backend (create, update, delete, fetch)
- [ ] Context parking modal & storage
- [ ] Deadline hierarchy classification
- [ ] Data models & database schema

### Week 2: UI & UX
- [ ] Task list view with urgency coloring
- [ ] Task detail sidebar with context + deadline info
- [ ] Completion celebration system (full-screen modal)
- [ ] Configurable celebration settings

### Week 3: Smart Features
- [ ] Smart prioritization algorithm
- [ ] "What next?" recommendation widget
- [ ] Weekly review dashboard
- [ ] GitHub OAuth + read integration

### Week 4: Polish & Testing
- [ ] Keyboard shortcuts (Cmd+P for parking, etc.)
- [ ] Accessibility audit (WCAG 2.1 AA)
- [ ] ADHD-friendly testing (user feedback loops)
- [ ] Mobile responsiveness
- [ ] Error handling & edge cases

---

## Success Metrics (Phase 1)

### Adoption
- 80%+ of users set deadline hierarchy on first 10 tasks
- 70%+ of users park context at least once per session
- 90%+ of users enjoy (vs. disable) celebrations

### Productivity
- Users complete 80% of planned daily tasks (vs. 50% baseline)
- Average task completion time decreases 20% (from faster resumption)
- Users report "clear on what to do next" at 9/10 confidence

### ADHD Support
- ADHD users report 3x higher task completion rate
- Motivation improvement: users want to maintain streaks
- Focus improvement: fewer "what was I doing?" moments

---

## Open Questions for Phase 1

1. Should parking context auto-save periodically, or manual only?
2. Should celebration be customizable per task (mute a specific task's celebration)?
3. Should team members see each other's deadline urgencies?
4. Should GitHub linking be automatic (detect mentions) or manual?
5. Should parking lot have a character limit, or markdown support?
