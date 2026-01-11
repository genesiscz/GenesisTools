# 001 - Personal AI Assistant for Developers, PMs & ADHD Support

## Vision

A comprehensive personal assistant system built into the GenesisTools dashboard that helps developers, product managers, and ADHD-affected individuals manage context fragmentation, task paralysis, interruptions, and burnout. The system acts as an intelligent task manager, context preserver, deadline tracker, and motivation engine - working seamlessly within the web app, with optional browser extension and mobile app support in the future.

**Core belief:** Knowledge workers lose productivity not from lack of work, but from:
- Context fragmentation (info scattered across Slack, GitHub, email, Jira)
- Task paralysis (too many options, can't decide what's next)
- Interruption overload (notifications, Slack, meetings destroy focus)
- Deadline anxiety (unclear which tasks are critical vs noise)
- Context switching cost (jumping between projects erases working memory)
- Motivation drain (ADHD brains need visible progress and celebration)

This assistant solves these problems through intelligent task prioritization, context preservation, deadline management, and psychological reinforcement.

## Target Users

1. **Developers** - Context switching between projects/PRs, managing code review feedback, tracking technical debt
2. **Product Managers** - Juggling priorities across features/bugs/tech debt, communicating with teams, managing changing requirements
3. **ADHD professionals** - Executive dysfunction, decision fatigue, motivation deficits, attention regulation challenges
4. **Distributed/async teams** - Coordinating work across timezones, managing handoffs, preventing knowledge loss

## Key Principles

1. **Configurability over defaults** - User owns their UX. Want sidebar? Got it. Want popups? Got it. Want modals? Configurable.
2. **Non-intrusive** - Assistant helps without nagging. No forced notifications unless user enables them.
3. **Context preservation** - System remembers what you were doing, why, and what you discovered.
4. **Deadline clarity** - No ambiguity about what's critical vs nice-to-have.
5. **Dopamine-driven for ADHD** - Celebration, streaks, badges, progress visibility.
6. **Minimal friction** - Logging context takes <30 seconds. Prioritization is smart, not manual.
7. **Privacy-first** - All data stays on-device/in dashboard. No external sync without consent.

## 14 Core Features

### Communication & Knowledge Layer
1. **Communication Log** - Snapshot important decisions/messages into searchable dashboard
2. **Context Parking Lot** - Quick-save your thoughts when switching tasks, auto-recall later
3. **Decision Log** - Formal decision capture with reasoning and date
4. **Handoff Compiler** - Auto-generate "here is everything" docs for async handoffs

### Deadline & Task Anxiety Layer
5. **Deadline Hierarchy** - Classify deadlines: critical/important/nice-to-have with visual urgency
6. **Critical Path Visualizer** - Show task dependencies and what blocks shipping
7. **Burndown Projection** - Given current velocity, predict deadline hit/miss
8. **Auto-Escalation Alerts** - When deadline approaches and progress lags, suggest solutions

### Motivation & ADHD Support Layer
9. **Completion Celebrations** - Big satisfying feedback when tasks complete
10. **Micro-Celebrations** - Celebrate focus sessions, streaks, milestones
11. **Achievement Badges** - Unlock badges for consistency and achievement
12. **Weekly Review Dashboard** - Progress metrics, trend analysis, AI-generated suggestions

### Deep Work & Focus Layer
14. **Blocker Detector** - Flag when task is blocked, suggest follow-up actions
16. **Energy/Focus Heatmap** - Understand circadian productivity patterns, optimize task timing
17. **Distraction Tracker** - Log interruptions, visualize patterns, suggest mitigation

---

## Architecture Overview

### Core Data Model

```typescript
interface Task {
  id: string
  userId: string
  title: string
  description: string
  projectId?: string

  // Deadline hierarchy
  deadline?: DateTime
  urgencyLevel: 'critical' | 'important' | 'nice-to-have'
  isShippingBlocker: boolean

  // Task breakdown (for paralysis)
  subtasks?: Task[]

  // Context management
  contextParkingLot?: string // "I was debugging X, found clue in Y"
  relatedDecisions?: string[] // decisionIds
  relatedCommunications?: string[] // communicationLogIds
  linkedGitHub?: string // PR/issue URL

  // Dependencies
  blockedBy?: string[] // taskIds
  blocks?: string[] // taskIds

  // Status & tracking
  status: 'backlog' | 'in-progress' | 'blocked' | 'completed'
  completedAt?: DateTime
  focusTimeLogged: number // minutes

  // Energy/distraction
  preferredTimeOfDay?: 'morning' | 'afternoon' | 'evening'
  tasksInterruptedThis: string[] // taskIds that interrupted this one

  createdAt: DateTime
  updatedAt: DateTime
}

interface CommunicationLogEntry {
  id: string
  userId: string
  source: 'slack' | 'github' | 'email' | 'manual'
  title: string
  content: string
  relatedTaskIds?: string[]
  tags?: string[]
  timestamp: DateTime
  createdAt: DateTime
}

interface DecisionLogEntry {
  id: string
  userId: string
  title: string // "Use React instead of Vue"
  reasoning: string
  alternatives?: string[] // Other options considered
  decidedAt: DateTime
  relatedTaskIds?: string[]
  status: 'active' | 'superseded' | 'reversed'
  createdAt: DateTime
}

interface CompletionEvent {
  id: string
  userId: string
  taskId: string
  completedAt: DateTime
  celebrationType: 'task-complete' | 'focus-session' | 'streak-milestone' | 'badge-earned'
  metadata?: {
    focusTimeSpent?: number // minutes
    streakDays?: number
    badgeName?: string
  }
}
```

### System Architecture

```
Dashboard Web App
├── Task Management Module
│   ├── Task list/detail views
│   ├── Task prioritization engine
│   └── Task breakdown suggestions
├── Context Management Module
│   ├── Parking lot capture
│   ├── Communication log indexing
│   ├── Decision log storage
│   └── Search/recall system
├── Deadline & Urgency Module
│   ├── Hierarchy classification
│   ├── Critical path calculation
│   ├── Burndown projection
│   └── Auto-escalation logic
├── Motivation & Celebration Module
│   ├── Completion celebration system
│   ├── Badge/streak tracking
│   ├── Weekly review generation
│   └── Dopamine reinforcement UI
├── Focus & Energy Module
│   ├── Activity tracking
│   ├── Energy heatmap calculation
│   ├── Distraction logging
│   └── Focus pattern detection
└── Integration Layer
    ├── GitHub API (read: PRs, issues, code context)
    ├── Optional X Bot (write: thread saving/summarization)
    ├── Chrome Extension (write: quick capture)
    └── Future: Jira, Linear, Slack APIs

```

### UX Configuration Tiers

Users can configure their experience:

**Tier 1: Dashboard-centric** (default)
- Primary view: task-focused sidebars
- Context parking lot, deadline info, celebrations in sidebars
- All interaction happens in dashboard

**Tier 2: Integrated sidebars** (smart integration)
- User starts task in dashboard: system auto-shows relevant sidebars
- Contextual info appears as you work
- Minimal modal interruptions

**Tier 3: Minimal modals** (non-intrusive)
- User works in code editor/design tool
- Small modals pop for: parking context, logging completion, deadline alerts
- Designed not to distract

**Tier 4+: Chrome extension** (stretch/future)
- Browser extension for quick-capture of messages, decisions, context
- One-click "save this to assistant"
- Syncs to dashboard

## Implementation Phases

### Phase 1: MVP (Core Features - Solves Immediate Pain)
- Context Parking Lot (solve knowledge loss on task switching)
- Deadline Hierarchy (solve deadline anxiety)
- Completion Celebrations (solve ADHD motivation)
- Basic task management + prioritization
- **Goal:** User has clear "what's next", remembers context, gets motivated by progress
- **Estimated scope:** 3-4 weeks focused dev

### Phase 2: Amplification (Complementary Features)
- Communication Log (solve context fragmentation)
- Decision Log (solve forgotten decisions)
- Critical Path Visualizer (understand shipping blockers)
- Blocker Detector (manage async work)
- Energy/Focus Heatmap (optimize personal productivity)
- **Goal:** User has complete visibility into work landscape and personal patterns
- **Estimated scope:** 2-3 weeks

### Phase 3: Refinement (Polish Features)
- Handoff Compiler (async team support)
- Auto-Escalation Alerts (deadline management)
- Micro-Celebrations (momentum building)
- Achievement Badges (long-term motivation)
- Weekly Review Dashboard (meta-productivity)
- Distraction Tracker (focus protection)
- **Goal:** System is fully self-improving and team-aware
- **Estimated scope:** 2-3 weeks

### Future: Expansion
- Jira/Linear integrations (deeper project tracking)
- Slack integration (communication auto-logging)
- Mobile app version
- Team collaboration features
- AI-powered coaching

## Revenue Model (Optional, Decide Later)

**Freemium approach:**
- **Free tier:** Core features (parking lot, deadline hierarchy, celebrations, basic prioritization)
- **Pro tier ($X/month):**
  - AI-powered task breakdown (breaking large tasks into microtasks automatically)
  - Smart priority weighting (energy + deadline + context automatically optimized)
  - Advanced analytics (distraction patterns, weekly insights)
  - GitHub integration (auto-pull PRs, code context)
  - X bot integration (save and summarize threads)
  - Advanced markdown notes (smart extraction for premium: extract blockers/dependencies/context from notes)

## Success Metrics

### Phase 1
- Users complete 80%+ of planned daily tasks (up from ~50% baseline)
- 90% of users report "clear on what to do next" (vs. baseline decision fatigue)
- 85% of users report improved focus (fewer context-switching moments)
- ADHD users report 3x+ motivation from celebrations

### Phase 2
- Users can articulate why each deadline matters (deadline clarity)
- 80% of users report better communication/decision retention
- Average focus session duration increases 30% (fewer interruptions)

### Phase 3
- Users report 40%+ less burnout (from activity tracking + rest enforcement)
- Teams report 50%+ faster async handoffs (from handoff compiler)
- Overall: Users feel "in control" of their work, not controlled by it

## Next Steps

1. **Validate Phase 1 design** - Read 002-assistant-phase1-detailed.md
2. **Review Phase 2 roadmap** - Read 003-assistant-phase2-roadmap.md
3. **Review Phase 3 roadmap** - Read 004-assistant-phase3-roadmap.md
4. **Implementation planning** - Identify MVP scope, tech stack, timeline
5. **User research** - Test concepts with 3-5 developers/PMs/ADHD folks before full build

---

## Design Philosophy Summary

This isn't a tool that manages you. It's a tool you configure to match how you work. It remembers what you forget, clarifies what's murky, celebrates what you achieve, and protects what matters: your focus, your time, and your motivation.

**For developers:** Less context switching, more deep work, clearer dependencies.

**For PMs:** Less deadline anxiety, clearer priorities, better communication.

**For ADHD folks:** Clear next step, celebration of progress, structure that supports (not judges) your executive function.
