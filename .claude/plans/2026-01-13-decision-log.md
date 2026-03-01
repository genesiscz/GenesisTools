# Decision Log Implementation Plan

## Overview
Implement a decision tracking system for the Personal AI Assistant to prevent re-debating settled decisions.

## Files to Create

### 1. Component Files (`src/routes/assistant/-components/decisions/`)

#### `DecisionCard.tsx`
- Glass card with status-colored badges (emerald=active, gray=superseded, rose=reversed)
- Shows: title, status badge, date, impact area tag
- Expandable sections for reasoning and alternatives
- Action buttons: Supersede, Reverse, Edit, Delete
- Uses FeatureCard pattern with color mapping based on status

#### `DecisionForm.tsx`
- Dialog form for creating/editing decisions
- Fields: title, reasoning (textarea), alternatives (array input), impact area (select), related tasks (multi-select), tags (comma-separated)
- Uses existing Dialog, Input, Textarea, Label components
- Purple-themed submit button

#### `DecisionTimeline.tsx`
- Visual timeline view of decisions
- Neon line connector between nodes
- Each node shows: date, title, status indicator
- Color coding by status
- Click to expand details

#### `SupersededChain.tsx`
- Shows decision evolution chain (decision -> superseded by -> etc)
- Arrow connectors between cards
- Compact card view
- Visual representation of why decisions changed

#### `DecisionLog.tsx`
- Main container component
- Status tabs with counts: Active, Superseded, Reversed, All
- Search bar for keyword filtering
- Filter dropdown for impact areas
- Grid of DecisionCards
- Empty state when no decisions

#### `index.ts`
- Export all components

### 2. Page File (`src/routes/assistant/decisions.tsx`)
- Replace placeholder with full implementation
- Use DashboardLayout
- Import and use DecisionLog component
- Connect to useDecisionLog hook
- Handle all CRUD operations

## Component Patterns to Follow

### Styling (Cyberpunk Aesthetic)
- Glass cards: `bg-[#0a0a14]/80 backdrop-blur-sm`
- Status colors:
  - Active: `emerald-500` (bg-emerald-500/10, border-emerald-500/30, text-emerald-400)
  - Superseded: `gray-500` (bg-gray-500/10, border-gray-500/30, text-gray-400)
  - Reversed: `rose-500` (bg-rose-500/10, border-rose-500/30, text-rose-400)
- Impact area colors:
  - frontend: purple
  - backend: blue
  - infrastructure: orange
  - process: cyan
  - architecture: amber
  - product: emerald
- Corner decorations using FeatureCard
- Neon glow effects on hover/active

### Animations
- `animate-fade-in-up` for staggered card entry
- Smooth height transition for expandable sections: `transition-all duration-300`
- Hover brightness: `hover:brightness-110`

### Data Flow
- Use `useDecisionLog` hook from `@/lib/assistant/hooks`
- Hook provides: decisions, loading, error, initialized
- CRUD: createDecision, updateDecision, deleteDecision
- Actions: supersedeDecision, reverseDecision
- Filters: getActiveDecisions, getSupersededDecisions, getReversedDecisions, getByImpactArea
- Utilities: getDecisionChain, getAllTags

## Implementation Order
1. DecisionCard.tsx - Core display component
2. DecisionForm.tsx - Create/edit modal
3. SupersededChain.tsx - Chain visualization
4. DecisionTimeline.tsx - Timeline view
5. DecisionLog.tsx - Main container
6. index.ts - Exports
7. decisions.tsx - Page implementation

## Types Used (from `@/lib/assistant/types`)
- `Decision` - Main entity
- `DecisionInput` - Create input
- `DecisionUpdate` - Update input
- `DecisionStatus` - 'active' | 'superseded' | 'reversed'
- `DecisionImpactArea` - 'frontend' | 'backend' | 'infrastructure' | 'process' | 'architecture' | 'product'
