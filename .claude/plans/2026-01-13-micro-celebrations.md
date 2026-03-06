# Micro-Celebrations Implementation Plan

## Overview
Implement a graduated celebration system with 3 tiers for the Personal AI Assistant dashboard.

## Architecture

### Files Structure
```
src/lib/assistant/components/celebrations/
  - MicroCelebration.tsx      # Tier 1: Toast notification (bottom-right, 3s)
  - BadgeNotification.tsx     # Tier 2: Center toast (5s, click to dismiss)
  - CelebrationManager.tsx    # Decides which tier to show
  - FocusSessionComplete.tsx  # Focus session completion toast
  - StreakMilestone.tsx       # Streak achievement toast
  - particles.ts              # Particle animation utilities
  - index.ts                  # Exports
```

### Celebration Tiers

**TIER 1 - Micro Toast (non-intrusive)**
- Position: bottom-right
- Duration: 3s auto-dismiss
- Animation: slide-in from right
- Use cases:
  - Focus session complete (25 min)
  - Small task complete (nice-to-have urgency)
  - 3-task day milestone

**TIER 2 - Badge Notification (center toast)**
- Position: center-bottom
- Duration: 5s, click to dismiss
- Animation: scale-in + glow pulse
- Use cases:
  - 5-day streak
  - 10 tasks completed
  - Speedrunner (5 tasks in day)

**TIER 3 - Full Celebration (existing CelebrationModal)**
- Use existing modal component
- Use cases:
  - Critical task complete
  - 7-day streak
  - Rare/legendary badge unlock

### State Management
- Use existing `useCelebrations` hook
- Add celebration mode preference to store: `full-party` | `subtle` | `silent`
- Store preference in localStorage

### Integration Points
1. `useTaskStore.completeTask()` - trigger celebrations
2. `useCelebrations` hook - manages pending/active celebrations
3. CelebrationManager component - renders appropriate tier

## Implementation Steps

1. Create celebrations directory and types
2. Implement MicroCelebration (Tier 1 toast)
3. Implement BadgeNotification (Tier 2 center toast)
4. Create CelebrationManager to orchestrate tiers
5. Add particle animation utilities
6. Integrate with task completion flow
7. Add celebration mode settings
8. Test all celebration triggers

## Cyberpunk Aesthetic Guidelines
- Neon border glow (emerald/amber/purple)
- Semi-transparent dark backgrounds
- Smooth slide-in animations
- Particle effects on badge unlock
- Font: monospace for stats, sans-serif for messages
