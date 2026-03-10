# Blocker Detector Implementation Plan

## Overview
Implement a blocker detection and tracking system for the Personal AI Assistant dashboard.

## Components to Create

### 1. `src/routes/assistant/-components/blockers/`
Location: `/Users/Martin/Tresors/Projects/GenesisTools/src/dashboard/apps/web/src/routes/assistant/-components/blockers/`

#### Files:
- `BlockerCard.tsx` - Single blocker display with time blocked
- `BlockerList.tsx` - Dashboard widget listing all blockers
- `BlockerActions.tsx` - Quick action buttons (remind, switch, wait)
- `BlockerModal.tsx` - Dialog for marking task as blocked
- `index.ts` - Exports

### 2. Update Task Detail Page
File: `src/routes/assistant/tasks/$taskId.tsx`
- Add "Mark as Blocked" button
- Show current blocker if task is blocked
- Add "Resolve Blocker" button

## Data Model (existing)
Using existing types from `@/lib/assistant/types`:
- `TaskBlocker` - Main blocker entity
- `TaskBlockerInput` - Input for creating blocker
- `BlockerFollowUpAction` - 'remind' | 'switch' | 'wait'

## Hook (existing)
Using `useBlockers` from `@/lib/assistant/hooks`:
- `addBlocker(input)` - Create blocker
- `resolveBlocker(id)` - Mark as resolved
- `getActiveBlockers()` - All unresolved blockers
- `getActiveBlockerForTask(taskId)` - Blocker for specific task
- `getLongStandingBlockers(days)` - Blockers older than N days
- `getBlockerDurationDays(blocker)` - Time blocked

## UI/UX Requirements

### Cyberpunk Aesthetic
- Rose/red color theme
- Glass cards with rose border
- Pulsing indicator for long-blocked (>2 days)
- Action buttons with hover glow

### Blocker Card Shows:
- Task title (linked)
- Blocker reason
- Blocker owner (if set)
- Time blocked
- Follow-up action set
- Quick actions

### Quick Actions:
1. "Remind @owner" - Shows draft message
2. "Switch task" - Link to What's Next
3. "Set reminder" - Date picker

### Urgency Coloring:
- < 1 day: Normal rose
- 1-2 days: Brighter rose
- > 2 days: Pulsing red with glow

## Implementation Order
1. Create blockers directory structure
2. Implement BlockerCard component
3. Implement BlockerActions component
4. Implement BlockerList widget
5. Implement BlockerModal dialog
6. Update task detail page with blocker section
7. Test and verify

## Commit Message
```
feat(blockers): implement blocker detection and tracking
```
