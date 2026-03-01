# Auto-Escalation Alerts Implementation Plan

**Date:** 2026-01-13
**Feature:** Deadline Risk Detection and Alerts

## Overview

Implemented proactive deadline risk detection and resolution options for the Personal AI Assistant dashboard. The system monitors tasks with deadlines and alerts users when tasks are at risk of missing their deadlines.

## Components Created

### 1. EscalationOptions.tsx
**Path:** `src/routes/assistant/-components/escalation/EscalationOptions.tsx`

Resolution option cards for handling deadline risks:
- **Extend Deadline**: Request more time with date picker
- **Get Help**: Add helper name and notes for pair programming
- **Cut Scope**: List features to defer or cut
- **Accept Risk**: Acknowledge delay with optional note

Features:
- Cyberpunk-styled cards with hover glow effects
- Recommended option highlighted with gradient badge
- Dynamic forms based on selected option
- Color-coded by option type (blue, purple, amber, red)

### 2. EscalationAlert.tsx
**Path:** `src/routes/assistant/-components/escalation/EscalationAlert.tsx`

Full escalation modal showing:
- Task details (title, deadline, progress)
- Risk metrics grid (deadline, time left, progress, projected completion)
- Progress bar with color coding
- Days late indicator
- Resolution options integration

Features:
- Critical (red) vs at-risk (yellow) styling
- Animated warning icons for critical risks
- Shadow/glow effects based on risk level

### 3. EscalationWidget.tsx
**Path:** `src/routes/assistant/-components/escalation/EscalationWidget.tsx`

Dashboard widget for the toolbar:
- Compact badge showing "X deadline(s) at risk"
- Color-coded by severity (red for critical, yellow for at-risk)
- Clickable to open escalation modal
- Pulsing animation for critical alerts
- Breakdown badges showing count by risk level

### 4. RiskIndicator.tsx (Enhanced)
**Path:** `src/routes/assistant/-components/escalation/RiskIndicator.tsx`

Risk badges for task cards:
- `RiskIndicator`: Basic pulsing dot indicator
- `RiskBadge`: Compact inline badge
- `TaskCardRiskIndicator`: Enhanced indicator with days late display

Features:
- Pulsing animation for critical risks
- Ping animation ring for red level
- Glow effects with CSS box-shadow

### 5. index.ts
**Path:** `src/routes/assistant/-components/escalation/index.ts`

Exports all escalation components for easy importing.

## Integration Points

### TaskCard.tsx (Updated)
**Path:** `src/lib/assistant/components/TaskCard.tsx`

Added props:
- `riskLevel?: DeadlineRiskLevel` - Risk level from useDeadlineRisk hook
- `daysLate?: number` - Days late for display
- `onRiskClick?: (taskId: string) => void` - Handler for opening escalation modal

New features:
- Risk indicator in header (between status and urgency badge)
- "Handle Risk" menu item in dropdown

### tasks/index.tsx (Updated)
**Path:** `src/routes/assistant/tasks/index.tsx`

Added:
- `useDeadlineRisk` hook integration
- `EscalationWidget` in toolbar (after streak indicator)
- `EscalationAlert` modal for handling risks
- Risk data passed to TaskCard and GridView
- Resolution handlers for all 4 options

## Risk Calculation Logic

The `useDeadlineRisk` hook (existing) calculates:

**Risk Levels:**
- `green`: On track (projected completion before deadline)
- `yellow`: At risk (< 2 days remaining OR < 50% complete with <= 5 days)
- `red`: Critical (projected late OR overdue)

**Recommended Actions:**
- `extend`: Red risk with >= 30% complete
- `scope`: Red risk with < 30% complete
- `help`: Yellow risk with < 50% complete
- `accept`: Green or yellow with >= 50% complete

## Cyberpunk Aesthetic

### Colors
- Yellow: At-risk warnings (yellow-400/500)
- Red: Critical alerts (red-400/500)
- Blue: Extend option (blue-400/500)
- Purple: Help option (purple-400/500)
- Amber: Scope option (amber-400/500)

### Animations
- `animate-pulse`: Pulsing dot indicators
- `animate-ping`: Ring effect for critical
- Custom `pulse-glow-red`: Pulsing shadow for critical widget

### Effects
- Box-shadow glow on risk indicators
- Gradient badges for recommended options
- Scale transforms on hover
- Transition effects on all interactive elements

## Data Flow

```
tasks -> useDeadlineRisk.calculateAllRisks() -> risks[]
                                                    |
                                                    v
                           +-> EscalationWidget (toolbar summary)
                           |
risks[] -> getRiskForTask(taskId) -> TaskCard (risk indicator)
                           |
                           +-> EscalationAlert (full modal)
                                       |
                                       v
                             EscalationOptions (resolution form)
                                       |
                                       v
                             handleEscalationResolve()
                                       |
                                       +-> updateTask() (extend/scope)
                                       +-> console.log() (help/accept)
                                       +-> calculateAllRisks() (refresh)
```

## Future Enhancements

1. **Communication Log Integration**: Log "help" requests as communication entries
2. **Decision Log Integration**: Log "accept risk" as decisions
3. **Notifications**: Push notifications for escalating risks
4. **Historical Tracking**: Track resolution choices over time
5. **Team Features**: Notify stakeholders when deadlines are extended
6. **Analytics**: Risk patterns and resolution effectiveness metrics
