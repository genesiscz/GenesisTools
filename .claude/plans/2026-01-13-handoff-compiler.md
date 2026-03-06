# Handoff Compiler Implementation Plan

## Overview
Create auto-generated context documents when tasks move to teammates. The Handoff Compiler provides a terminal/console-styled document preview with editable sections.

## Architecture

### Components to Create

1. **`src/routes/assistant/-components/handoff/`**
   - `HandoffDocument.tsx` - Compiled handoff view with cyberpunk terminal style
   - `HandoffPreview.tsx` - Preview modal before sending
   - `HandoffEditor.tsx` - Edit/customize sections
   - `HandoffHistory.tsx` - Past handoffs list
   - `index.ts` - exports

2. **Update Task Detail Page**
   - Add "Hand off task" button to `$taskId.tsx`
   - Show handoff banner if task was handed to current user
   - Acknowledge button functionality

## Component Details

### HandoffDocument.tsx
A read-only view of a compiled handoff document styled like a terminal output.

**Sections:**
- Summary (task title + description)
- Context Notes (from parking lot)
- Decisions Made (linked decisions)
- Blockers (current blockers)
- Next Steps (editable list)
- Gotchas (editable notes)
- Contact info

**Styling:**
- Monospace font for context
- Neon underlines for section headers (cyan glow)
- Glass card container
- Terminal prompt style prefixes

### HandoffPreview.tsx
Modal dialog for previewing the handoff before sending.

**Features:**
- "Hand off to" text input
- Preview of compiled document
- Edit button to switch to editor
- Send/Cancel buttons
- Auto-compile from task data

### HandoffEditor.tsx
Form for editing handoff sections before sending.

**Editable Fields:**
- Summary (pre-filled from task)
- Context Notes (pre-filled from parking)
- Next Steps (array input)
- Gotchas (textarea)
- Contact info (text input)

### HandoffHistory.tsx
List of past handoffs for a task.

**Features:**
- Timeline view
- Status indicators (pending review, acknowledged)
- Link to view full document

## Data Flow

1. User clicks "Hand off task" button
2. System auto-compiles handoff from:
   - Task title/description
   - Active parking context
   - Linked decisions (from useDecisionLog)
   - Active blockers (from useBlockers)
3. User reviews in HandoffPreview
4. User can edit in HandoffEditor
5. User enters recipient and sends
6. Handoff stored via useHandoff hook

## Hooks Integration

- `useHandoff` - Create/update/acknowledge handoffs
- `useTaskStore` - Get task and parking data
- `useDecisionLog` - Get related decisions
- `useBlockers` - Get current blockers

## UI States

### Sender View
- "Hand off task" button in task detail header
- HandoffPreview modal
- HandoffEditor modal (if editing)

### Receiver View
- Banner at top of task detail: "Task handed off to you from @sender"
- Acknowledge button
- View handoff document link

## Cyberpunk Styling

```css
/* Terminal style */
.handoff-terminal {
  font-family: 'JetBrains Mono', monospace;
  background: rgba(10, 10, 20, 0.9);
  border: 1px solid rgba(0, 255, 255, 0.2);
}

/* Section headers */
.handoff-section-header {
  color: #00ffff;
  border-bottom: 2px solid transparent;
  border-image: linear-gradient(90deg, #00ffff, transparent) 1;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

/* Prompt prefix */
.handoff-prompt::before {
  content: '>';
  color: #00ffff;
  margin-right: 0.5rem;
}
```

## Implementation Order

1. Create index.ts with exports
2. Create HandoffDocument.tsx (view)
3. Create HandoffEditor.tsx (form)
4. Create HandoffPreview.tsx (modal)
5. Create HandoffHistory.tsx (list)
6. Update $taskId.tsx with button and banner
