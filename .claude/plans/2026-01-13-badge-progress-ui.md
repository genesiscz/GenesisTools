# Badge Progress UI Implementation Plan

## Overview
Create a badge showcase with earned badges and progress toward new ones for the Personal AI Assistant dashboard.

## Files to Create

### 1. `src/routes/assistant/-components/badges/BadgeCard.tsx`
Single badge display with:
- Rarity-colored glow effects
- Badge icon (from Lucide)
- Display name and description
- Earned date for unlocked badges
- Tooltip with badge details
- Legendary badges pulse with gold shimmer

### 2. `src/routes/assistant/-components/badges/BadgeShowcase.tsx`
Earned badges grid:
- Grid layout for earned badges
- Empty state when no badges earned
- Badge count header
- Filter by rarity option

### 3. `src/routes/assistant/-components/badges/BadgeProgress.tsx`
Progress bars for in-progress badges:
- Shows badges not yet earned
- Neon-filled progress bars
- Current/target values
- Percentage complete
- Remaining text

### 4. `src/routes/assistant/-components/badges/BadgeUnlockAnimation.tsx`
Unlock celebration overlay:
- Dialog-based modal
- Confetti particle burst
- Badge flies in animation
- Rarity glow effect
- Dismiss/share buttons

### 5. `src/routes/assistant/-components/badges/index.ts`
Exports all badge components

### 6. Update `src/routes/assistant/analytics.tsx`
Add badges section to the analytics page:
- Replace placeholder content
- Add BadgeShowcase for earned badges
- Add BadgeProgress for in-progress badges

## Rarity Color Scheme
- Common: gray/silver (`gray-400`, `gray-500`)
- Uncommon: green (`green-400`, `green-500`)
- Rare: blue/purple (`purple-400`, `purple-500`)
- Legendary: amber/gold with glow (`amber-400`, `amber-500`)

## Cyberpunk Aesthetic
- Dark backgrounds with colored glows
- Neon progress bar fills
- Tech corner decorations (like FeatureCard)
- Pulse animations for legendary badges
- Particle burst on unlock

## Dependencies
- Existing: useBadgeProgress hook
- Existing: Badge, BadgeProgress types
- Existing: BADGE_DEFINITIONS
- Existing: getBadgeRarityColor utility
- Lucide icons for badge icons
