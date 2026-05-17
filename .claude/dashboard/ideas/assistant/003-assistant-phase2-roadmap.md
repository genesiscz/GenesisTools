# 003 - Assistant Phase 2: Roadmap (Communication, Context, Analytics)

## Phase 2 Overview

After Phase 1 establishes core task management with context preservation and deadline clarity, Phase 2 amplifies the assistant's intelligence through:

1. **Communication Log** - Aggregate decisions/messages from scattered sources into searchable knowledge base
2. **Decision Log** - Formal capture of decisions to prevent re-debating
3. **Critical Path Visualizer** - Understand task dependencies and shipping blockers
4. **Blocker Detector** - Intelligently flag when tasks are blocked and suggest actions
5. **Energy/Focus Heatmap** - Understand personal circadian productivity patterns

**Phase 2 adds:** Complete visibility into work landscape + personal productivity optimization

**Timeline estimate:** 2-3 weeks after Phase 1 ships and stabilizes

---

## Feature 1: Communication Log

### Problem
Decisions are scattered: "We decided on React in a Slack thread", "Use Docker for deployment in code review comments", "Postpone refactoring in a standup". Finding or recalling these decisions is hard.

### Solution
One unified log of important decisions/messages from Slack, GitHub, email, manual entry. Searchable, taggable, linked to tasks.

### User Flow

1. User encounters important message in Slack/GitHub
2. Options:
   - **Manual entry:** Opens Communication Log, clicks "Add decision/message"
     ```
     Title: Decided to use React hooks instead of classes
     Source: Slack #architecture
     Content: [paste or type]
     Tags: [architecture, frontend, decision]
     Related tasks: [link to tasks affected]
     ```
   - **Quick capture (future):** Chrome extension context menu → "Save to Communication Log"

3. User later searches: "What did we decide about state management?"
   - Search results show decision entries
   - Each shows: date, source, reasoning, related tasks
   - Can click to expand full context

### Data Model

```typescript
interface CommunicationLogEntry {
  id: string
  userId: string
  title: string
  content: string
  source: 'slack' | 'github' | 'email' | 'manual' | 'meeting_notes'
  sourceUrl?: string // Link back to Slack thread, GitHub comment, etc.

  // Metadata
  discussedAt: DateTime
  loggedAt: DateTime
  tags?: string[] // 'architecture', 'decision', 'blocker', 'urgent'
  relatedTaskIds?: string[] // Links to affected tasks
  sentiment?: 'decision' | 'discussion' | 'blocker' | 'context'

  // Search
  searchableContent: string // Indexed for search

  updatedAt: DateTime
}

// Search index (for fast queries)
interface CommunicationIndex {
  userId: string
  entries: CommunicationLogEntry[]
  lastRebuilt: DateTime
  // Elasticsearch or similar for production
}
```

### UX

**Dashboard view:**
```
Main nav: [Tasks] [Calendar] [Communication Log] [Decisions] [Analytics]

Communication Log page:
├─ Search bar: "Search decisions, messages, context..."
├─ Filter tabs: [All] [Decisions] [Blockers] [Context] [Custom tags]
├─ Results list:
│  ├─ "Decided to use React hooks" - 2 weeks ago - #architecture
│  ├─ "Database migration postponed" - 3 days ago - #blocker
│  └─ "Use Docker for prod deployment" - 1 month ago - #infrastructure
│
├─ Click entry to expand:
│  ├─ Full content
│  ├─ Source (Slack thread link, GitHub comment, etc.)
│  ├─ Related tasks: [Task A] [Task B]
│  ├─ Comments section (add follow-up context)
│  └─ Edit / Archive options
```

**Task integration:**
When viewing a task, related communication entries show in sidebar:
```
Task: Implement state management

📞 Related decisions:
"Decided to use React hooks instead of classes" (link to log entry)
"Use Redux or Context API?" (discussion thread link)
```

### Integration with Other Features

**Decision Log (Feature 2):** Decisions can auto-populate decision log
**Task context:** Communication entries appear in task detail
**Search:** Global search includes communication log
**Teams (future):** Team members can access shared communication log

### Success Criteria

- Users can find any important decision from the last 6 months in <1 minute
- 80% of decisions are captured before being forgotten
- 0 re-debates of settled decisions (vs. "I thought we decided this differently")
- Search is fast and accurate (vs. scrolling through Slack)

### Technical Notes

- Search: Implement full-text search (Postgres `tsvector` or Elasticsearch)
- Import: Option to bulk-import from Slack API later
- Archive: Old entries archive after 1 year (manual or auto)
- Notifications: Can receive digest of new communication log entries

---

## Feature 2: Decision Log

### Problem
"Didn't we decide this already?"
Decisions are made, forgotten, and re-debated. Same 3-hour discussion happens quarterly.

### Solution
Formal decision capture with reasoning, alternatives considered, date. When reconsidering a decision, system surfaces it.

### User Flow

1. Team makes decision: "Use Vue instead of React"
2. User opens Decision Log, clicks "Add decision"
   ```
   Decision: Use Vue instead of React for new dashboard

   Reasoning:
   - Smaller bundle size (important for mobile)
   - Faster prototyping for tight deadline
   - Team expertise with Vue higher

   Alternatives considered:
   - React (full ecosystem, but heavier)
   - Svelte (too new, less team familiarity)
   - Angular (overkill for our needs)

   Status: ACTIVE
   Decided at: [date]
   By: [user]
   ```

3. 6 months later, someone suggests "Should we use React instead?"
4. System surfaces: "We decided on Vue 6 months ago because [reasoning]. Alternatives: React, Svelte, Angular. Want to supersede this decision?"
5. If yes, mark old decision as SUPERSEDED, create new decision: "Switch to React"

### Data Model

```typescript
interface DecisionLogEntry {
  id: string
  userId: string
  title: string
  reasoning: string // Why this decision
  alternativesConsidered?: string[] // Other options
  decidedAt: DateTime
  decidedBy: string // userId
  status: 'active' | 'superseded' | 'reversed' | 'archived'

  // Tracking
  relatedTaskIds?: string[]
  impactArea?: string // 'frontend', 'backend', 'infrastructure', 'process'
  reversedAt?: DateTime
  reversalReason?: string

  updatedAt: DateTime
}

// Decision recurrence detection
interface DecisionRecurrence {
  originalDecisionId: string
  timesReconsidered: number
  lastReconsideredAt: DateTime
}
```

### UX

**Dashboard:**
```
Decisions page:
├─ Status tabs: [Active] [Superseded] [Reversed] [All]
├─ Filter by: [Frontend] [Backend] [Process] [Team]
├─ Timeline view (optional):
│  ├─ Most recent decisions first
│  └─ Shows reversals/supersessions
│
├─ Each decision shows:
│  ├─ Title + reasoning (one-line summary)
│  ├─ Date decided
│  ├─ Status + context
│  └─ [View details] [Reverse decision] [Archive]
```

**Alert system:**
When user or system detects someone might be re-debating:
```
❓ Wait, didn't we decide this?

Decision: "Use Vue instead of React"
Decided: 6 months ago
Reasoning: Smaller bundle, faster prototype, team expertise

Want to supersede this decision?
[Explore alternatives] [Stick with Vue] [Reverse decision]
```

### Integration

**Task context:** Decision log entries link to related tasks
**Communication Log:** Important discussions reference decisions
**Team collaboration (future):** Team sees decision timeline + reasoning

### Success Criteria

- 0 repeated decision debates (same question not re-debated)
- 90% of decisions captured before being questioned
- Decision clarity: "Why did we choose Vue?" answered in <10 seconds
- Easy reversals: When reconsideration is warranted, system supports it smoothly

---

## Feature 3: Critical Path Visualizer

### Problem
With multiple tasks, it's unclear what blocks shipping. "Task A depends on B, B depends on C, so if C is delayed..." becomes too complex to think through.

### Solution
Visual dependency graph showing task relationships and critical path to shipping.

### User Flow

1. User has project: "v2.0 release" with 15 tasks
2. Tasks have dependencies:
   ```
   Design mockups → Frontend implementation → Code review
   ↓ (both needed for)
   Integration testing → Deployment → Release

   Backend API → Integration testing (above)
   Database schema → Backend API
   ```

3. User clicks "Show critical path" in project view
4. System visualizes:
   ```
   [Design] →→→→→→ [Frontend] → [Code review]
                          ↓
   [Schema] → [API] ─────→→→→→ [Integration test] → [Deploy] → [Release]
   ```

5. Critical path (longest chain) highlighted in RED:
   ```
   Schema → API → Integration → Deploy → Release
   (5 days to complete, currently at day 2)
   ```

6. UI shows:
   ```
   🔴 Critical path to release: 5 days
   ✅ Current progress: Schema complete, API 50% done
   ⚠️ If API takes >3 more days, you'll miss deadline
   ```

### Data Model

```typescript
interface TaskDependency {
  taskId: string
  dependsOn: string[] // Array of taskIds this depends on
  blocksShipping: boolean // Is this part of critical path?
  estimatedDays: number // Estimated time to complete
}

interface CriticalPath {
  projectId: string
  tasks: string[] // Ordered list of taskIds in critical path
  totalDays: number
  daysRemaining: number
  isOnTrack: boolean // Will deadline be hit?
  bottlenecks: string[] // taskIds that are slowing progress
}
```

### UX

**Project view:**
```
Project: v2.0 Release
├─ Dashboard card shows: "Critical path: 5 days | 2 days complete"
├─ Visual graph (interactive):
│  ├─ Click node to see task details
│  ├─ Drag to reorganize (if can move tasks)
│  ├─ Color coding: Red (critical path), Gray (non-blocking)
│  └─ Hover edge to see dependency reason
│
└─ Analysis panel:
   ├─ "Critical path: Schema → API → Testing → Deploy → Release"
   ├─ "Bottleneck: API (50% done, blocking 3 other tasks)"
   ├─ "Risk: If API takes >3 more days, deadline at risk"
   └─ [Accelerate API] [Parallelize testing] [Extend deadline]
```

### Success Criteria

- Users understand what blocks shipping in <30 seconds
- Critical path identifies true bottleneck (validated by team)
- On-time shipping: projects using critical path ship 90% on time
- Prevents surprises: "Didn't know this task blocked everything"

### Technical Notes

- Dependency graph calculation: topological sort to find critical path
- Visualization: D3.js or similar for interactive graph
- Estimates: Use task time-spent data + projections
- Recalculates: Daily or when tasks updated

---

## Feature 4: Blocker Detector

### Problem
Task is stuck: "Waiting on code review from Sarah", "Can't proceed without database schema", "Need design approval".
Without tracking this, blockers are invisible, and you waste time on tasks that can't be completed.

### Solution
System detects when tasks are blocked and intelligently suggests follow-ups or context for next person.

### User Flow

1. User logs: "Task A blocked. Waiting on code review from @sarah"
2. System detects blocker:
   ```
   Task A: Implement user auth
   Status: BLOCKED
   Reason: "Waiting on code review from @sarah"
   Blocked since: 2 days ago
   ```

3. Assistant suggests:
   - "Remind Sarah about pending review?" (auto-draft message)
   - "Switch to Task B while waiting?" (show non-blocked tasks)
   - "Follow up with Sarah in 24h if no response?" (set reminder)

4. When Task A becomes unblocked (review arrives), system notifies:
   ```
   ✅ Your blocker is resolved!
   Task A: Code review approved by @sarah
   Ready to merge and move forward
   ```

### Data Model

```typescript
interface TaskBlocker {
  taskId: string
  status: 'blocked' | 'unblocked'
  reason: string // "Waiting on code review", "Awaiting design approval"
  blockedSince: DateTime
  unblockedAt?: DateTime
  blockerOwner?: string // Person/team blocking (if applicable)
  followUpAction?: string // "Remind in 24h", "Switch to Task B"
  relatedTaskIds?: string[] // Other tasks blocked by same issue
}
```

### UX

**Task detail view:**
```
Task: Implement user auth

Status: 🔴 BLOCKED
├─ Reason: "Waiting on code review from @sarah"
├─ Blocked since: 2 days ago
├─ Quick actions:
│  ├─ [Remind @sarah] "Hey Sarah, when you get a moment..."
│  ├─ [Switch to Task B] (show available non-blocked tasks)
│  ├─ [Set reminder] (remind you in 24h to follow up)
│  └─ [Mark unblocked] (manually if blocker resolved)
```

**Dashboard blocker list:**
```
Your blockers:
├─ Task A (blocked 2 days)
├─ Task B (blocked 5 hours)
└─ Task C (blocked 1 day)

Recommendations:
├─ "Remind @sarah about Task A review"
├─ "Follow up on Task C (design approval)"
└─ "Task B should be unblocked soon, check status"
```

### Integration with Async Features (Future)

When task is handed off to teammate:
```
Handoff package includes:
├─ Task description
├─ Blocker status (if any): "Waiting on Sarah's code review"
└─ Suggested follow-up: "Remind Sarah in 24h if not reviewed"
```

### Success Criteria

- 0 forgotten blockers (all visible in dashboard)
- Users spend 50% less time on blocked tasks (switch to unblocked work)
- Blockers are resolved 30% faster (reminders + visibility)
- No surprises when tasks are supposed to ship

### Technical Notes

- Detection: Can be manual (user tags task as blocked) or AI-assisted (detect "waiting on", "blocked by" in notes)
- Reminders: Optional scheduled notifications
- Analytics: Track blocker patterns (what blocks most work?)

---

## Feature 5: Energy/Focus Heatmap

### Problem
"When am I most productive?" isn't obvious. Some people code best 6am-9am, others 10pm-midnight.
Matching task types to peak energy = more productive work, fewer context switches.

### Solution
Analyze task completion times + focus quality throughout week. Show when user is most productive, recommend optimal task timing.

### User Flow

1. System collects data over 2-3 weeks:
   - When user completes tasks (task done timestamps)
   - How many context switches per hour
   - Focus session quality (how long uninterrupted)
   - User-reported energy at task completion

2. After sufficient data, Energy Heatmap appears:
   ```
   Your productivity patterns:

   ┌─────────────────────────────────────────┐
   │  Mon  Tue  Wed  Thu  Fri  Sat  Sun      │
   │                                         │
   │ 9am  🔴  🟠  🟠  🟠  🟠  ⬜   ⬜       │ Best focus
   │ 12pm 🟡  🟡  🟡  🟡  🟡  🟡   🟡       │ Medium focus
   │ 3pm  🔵  🔵  🔵  🔵  🔵  🟡   🟡       │ Interrupted/low
   │ 6pm  ⬜   ⬜   ⬜   ⬜   ⬜   🔵   🔵      │ Low energy
   │                                         │
   └─────────────────────────────────────────┘

   Insights:
   ├─ "Your peak focus: Monday-Friday 9am-12pm (RED zone)"
   ├─ "Afternoon slump: 3pm-5pm consistent pattern"
   ├─ "Weekend: Lower energy but good for admin tasks"
   └─ "Task recommendation: Schedule deep work 9am-12pm, meetings 3pm-5pm"
   ```

3. System uses this for task recommendations:
   - It's 9am Monday: "Perfect time for deep coding work. Task A (complex)?"
   - It's 3pm Friday: "Energy dip time. Try Task B (administrative)?"

### Data Model

```typescript
interface EnergySnapshot {
  userId: string
  timestamp: DateTime
  focusQuality: 1 | 2 | 3 | 4 | 5 // Self-reported or calculated
  contextSwitches: number // # of task switches in last hour
  tasksCompleted: number
  typeOfWork?: 'deep-work' | 'communication' | 'admin' | 'meeting'
}

interface EnergyHeatmap {
  userId: string
  pattern: {
    [dayOfWeek: string]: {
      [hour: number]: {
        avgFocusQuality: number
        avgContextSwitches: number
        suggestedTaskType: string
      }
    }
  }
  peakHours: string[] // ["Monday 9-12", "Friday 2-4"]
  lowEnergyHours: string[]
  calculatedAt: DateTime
}
```

### UX

**Dashboard Analytics page:**
```
Energy & Productivity Analytics
├─ Heatmap grid (interactive):
│  ├─ Hover cell to see detail: "Mon 10am: 4.5/5 focus, 1 switch, 3 tasks done"
│  ├─ Darker color = higher focus/productivity
│  └─ Click to see tasks completed at that time
│
├─ Insights section:
│  ├─ "Peak focus: Mon-Fri 9am-12pm"
│  ├─ "Afternoon slump: 2pm-4pm (do admin tasks)"
│  ├─ "Context switches highest: Tuesday 2-3pm"
│  └─ "Recommendation: Block calendar 9-11am for deep work"
│
└─ Task recommendation banner:
   ├─ "It's 9:15am Monday (your peak time)"
   ├─ "Best for: Deep technical work"
   └─ [Work on Task A (complex)] [See all options]
```

### Integration

**Task prioritization:** Energy considered in "What next?" algorithm
**Focus protection:** "Block 2-hour deep work at your peak time?" suggestion
**Team insights (future):** Understand team's collective productivity patterns

### Success Criteria

- Users identify their peak 4 hours/week within 2 weeks
- Deep work scheduled during peak hours: 80% of deep work
- Productivity increases 20% by matching task type to energy
- Users report better work-life balance (no forced late nights)

### Technical Notes

- Data collection: Automatic based on task completion + user logging
- Privacy: All analysis client-side (no external ML)
- Calculation: Aggregation over rolling 3-week window
- Visualization: Heatmap using Canvas or SVG

---

## Phase 2 Timeline

### Week 1: Communication & Decision Logs
- [ ] Communication Log storage & search
- [ ] Decision Log data model
- [ ] UI for adding/viewing entries
- [ ] Search indexing (Postgres tsvector)

### Week 2: Dependencies & Visualization
- [ ] Task dependency linking
- [ ] Critical Path algorithm (topological sort)
- [ ] Interactive dependency visualization (D3.js)
- [ ] Blocker detection logic

### Week 3: Analytics & Energy
- [ ] Energy snapshot collection
- [ ] Heatmap calculation algorithm
- [ ] Analytics dashboard UI
- [ ] Task recommendation integration

### Week 4: Polish & Integration
- [ ] Cross-feature integration testing
- [ ] Performance optimization (large task graphs)
- [ ] Mobile responsiveness
- [ ] Documentation & user onboarding

---

## Phase 2 Success Metrics

- Users save 30 minutes/week searching for decisions (vs. scrolling Slack)
- 0 repeated decision debates
- Critical path catches 90% of shipping blockers before deadline slip
- Blockers resolved 30% faster
- Users identify peak productivity hours and shift work accordingly

---

## Known Constraints / Future Considerations

1. **Team collaboration:** Phase 2 focuses on individual. Shared communication log comes in Phase 3.
2. **AI detection:** Blocker detection is mostly manual initially. ML detection (surface-level NLP) in future.
3. **Slack import:** Communication Log can pull from Slack API later (after Phase 2 launch).
4. **Time estimation:** Critical path uses rough estimates. Refine with historical data over time.

---

## Transition to Phase 3

Phase 2 provides complete visibility into work landscape. Phase 3 adds:
- Handoff automation (async team support)
- Auto-escalation (deadline warnings before crisis)
- Advanced celebrations (badges, achievements)
- Weekly/monthly reviews
- Distraction pattern analysis
