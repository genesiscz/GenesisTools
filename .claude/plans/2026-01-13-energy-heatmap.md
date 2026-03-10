# Energy Heatmap Implementation Plan

## Overview
Implement a productivity patterns visualization showing when user is most focused using a 7x24 grid (days of week x hours) with cyberpunk aesthetic.

## Files to Create

### 1. HeatmapCell.tsx
- Individual cell component with tooltip
- Color intensity based on focus quality (1-5 scale)
- Hover state with neon glow effect
- Tooltip showing: day/time, focus quality, context switches, tasks completed

### 2. EnergyHeatmap.tsx
- 7x24 grid container
- Renders HeatmapCell for each hour/day combination
- Row labels (Mon-Sun), Column labels (hours)
- Color scale legend
- Scanline CSS animation effect
- Uses useEnergyData hook for data

### 3. EnergyInsights.tsx
- Pattern analysis panel
- Peak focus time identification
- Afternoon slump detection
- Best day of week
- Glass card with cyberpunk styling

### 4. FocusRecommendation.tsx
- Time-based task suggestion banner
- Shows when current time matches peak focus hours
- Links to recommended complex task
- Dismissible banner

### 5. LogEnergyModal.tsx
- Quick self-report dialog
- Focus quality slider (1-5)
- Work type selector
- Context switches count
- Notes field

### 6. index.ts
- Export all analytics components

## Files to Modify

### analytics.tsx
- Replace placeholder with actual implementation
- Add EnergyHeatmap section
- Add Insights panel
- Add Log Energy button
- Add Focus Recommendation banner

## Design Tokens (Cyberpunk)
- Grid borders: cyan-500/20
- Low energy: slate-800 (dark)
- Medium energy: cyan-700
- High energy: cyan-400 (bright)
- Peak energy: amber-400 with glow
- Scanline: rgba(0, 255, 255, 0.05) repeating gradient
- Glass card: bg-slate-900/80 backdrop-blur

## Data Flow
1. useEnergyData hook fetches last 30 days of snapshots
2. getHeatmapData computes averages by day/hour
3. Grid cells render with computed intensity
4. Insights computed from hourlyAverages/dailyAverages
5. Current time compared to peak hours for recommendation
