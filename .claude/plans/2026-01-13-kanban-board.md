# Kanban Board Implementation Plan

## Overview
Implement a drag-and-drop Kanban board for task management with 4 columns using @dnd-kit libraries.

## Components to Create

### 1. `src/routes/assistant/-components/kanban/KanbanBoard.tsx`
- Main container with DndContext from @dnd-kit/core
- Manages drag state and handles DragEnd events
- Uses DragOverlay for preview during drag
- Handles status updates via useTaskStore.updateTask()
- Optimistic updates with rollback on error

### 2. `src/routes/assistant/-components/kanban/KanbanColumn.tsx`
- Uses useDroppable from @dnd-kit/core
- Props: status, color, title, tasks, onAddTask
- Glassmorphism styling with backdrop-blur
- Neon border glow matching column color
- Tech corner decorations (like FeatureCard)
- Shows count badge in header

### 3. `src/routes/assistant/-components/kanban/KanbanCard.tsx`
- Uses useDraggable from @dnd-kit/core
- Simplified version of TaskCard
- Shows: title, urgency badge, deadline
- Click navigates to /assistant/tasks/$taskId
- Drag preview with scale(1.05) and shadow

### 4. `src/routes/assistant/-components/kanban/KanbanHeader.tsx`
- Column header with icon, title, count badge
- "Add Task" button per column

### 5. `src/routes/assistant/-components/kanban/index.ts`
- Barrel exports

## Column Configuration

| Column | Status | Color | Icon |
|--------|--------|-------|------|
| Backlog | backlog | cyan | Circle |
| In Progress | in-progress | amber | Play |
| Blocked | blocked | rose | Ban |
| Completed | completed | emerald | CheckCircle |

## Rewrite: `src/routes/assistant/tasks/index.tsx`
- Replace grid view with KanbanBoard
- Keep toolbar (filters, park, add task)
- Pass tasks and handlers to KanbanBoard

## Styling Requirements

### Cyberpunk Aesthetic
- Glassmorphism: `bg-[#0a0a14]/80 backdrop-blur-sm`
- Neon borders: `border-{color}-500/20 hover:border-{color}-500/40`
- Corner decorations: Same pattern as FeatureCard
- Glow effect on columns

### Drag Interactions
- Drag preview: `scale-[1.05] shadow-2xl shadow-{color}-500/30`
- Drop target highlight: `ring-2 ring-{color}-500/50`
- Smooth spring animations via CSS transitions

### Mobile
- Horizontal scroll: `overflow-x-auto snap-x snap-mandatory`
- Column width: `min-w-[280px] w-[85vw] sm:w-auto`

## Implementation Order
1. Create KanbanCard.tsx
2. Create KanbanHeader.tsx
3. Create KanbanColumn.tsx
4. Create KanbanBoard.tsx
5. Create index.ts
6. Rewrite tasks/index.tsx
