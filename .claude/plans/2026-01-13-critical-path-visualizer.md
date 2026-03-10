# Critical Path Visualizer - Implementation Plan

## Overview
Create a visual dependency graph showing task relationships and critical path to shipping for the Personal AI Assistant dashboard.

## Architecture

### Files to Create

1. **`src/routes/assistant/-components/critical-path/`**
   - `CriticalPathGraph.tsx` - Main SVG graph with pan/zoom
   - `DependencyNode.tsx` - Hexagonal task node component
   - `PathAnalysis.tsx` - Analysis panel showing bottlenecks
   - `BottleneckAlert.tsx` - Warning component for bottlenecks
   - `DependencySelector.tsx` - Task dependency picker for task detail
   - `useCriticalPath.ts` - Hook for graph calculations
   - `graph-utils.ts` - Topological sort, critical path algorithms
   - `index.ts` - Exports

2. **Update `src/routes/assistant/tasks/$taskId.tsx`**
   - Add "Depends on" task selector
   - Add "Blocks" task display
   - Add "View in Critical Path" link

### Types (Already in types.ts)
- `GraphNode` - Node with position, level, critical path status
- `GraphEdge` - Edge between nodes
- `CriticalPathAnalysis` - Analysis results
- `ViewportState` - Pan/zoom state

## Component Details

### CriticalPathGraph.tsx
- SVG-based interactive graph
- Pan: Mouse drag on background
- Zoom: Scroll wheel
- Node click: Show task tooltip
- Critical path: Red pulsing edges
- Non-critical: Gray edges
- Cyberpunk grid background

### DependencyNode.tsx
- Hexagon shape with glow effect
- Color based on task urgency
- Critical path nodes have red glow
- Bottleneck indicator (warning icon)
- Progress ring around hexagon

### PathAnalysis.tsx
- Critical path sequence display
- Days to completion estimate
- Bottleneck warnings
- Task counts

### Graph Algorithms (graph-utils.ts)
1. **Topological Sort**: Kahn's algorithm for level assignment
2. **Critical Path**: Longest path through DAG
3. **Bottleneck Detection**: Most downstream dependencies
4. **Layout**: Force-directed within levels

## Cyberpunk Aesthetic
- Dark grid background (#0a0a14)
- Neon glow effects (purple, cyan, red)
- Hexagonal nodes
- Pulsing animations on critical path
- Tech corners on panels

## Responsive Design
- Desktop: Full graph with analysis panel
- Tablet: Collapsible analysis panel
- Mobile: Simplified list view with path indicator
