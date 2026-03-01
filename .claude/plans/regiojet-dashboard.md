# Regiojet Travel Dashboard - Implementation Plan

## Overview

Create a new "Regiojet" page in the claude-history-dashboard that fetches, caches, and visualizes travel history from the Regiojet API with comprehensive statistics and cyberpunk-styled charts.

## API Endpoints

### 1. Tickets API (Primary - Rich Data)
```
GET https://brn-ybus-pubapi.sa.cz/restapi/tickets?dateFrom=2020-01-01&dateTo=2026-01-17&sortDirection=DESC&limit=100
```

**Returns:**
- `id`, `ticketCode`, `routeId`, `price`, `currency`, `state`
- `seatClassKey` (TRAIN_LOW_COST, etc.)
- `routeSections[].section`:
  - `vehicleType` (TRAIN, BUS)
  - `line` (code, from, to, lineGroupCode)
  - `departureCityName`, `departureStationName`, `departureTime`
  - `arrivalCityName`, `arrivalStationName`, `arrivalTime`
  - `services[]` (wifi, catering, etc.)

### 2. Payments API (Secondary - Financial Data)
```
GET https://brn-ybus-pubapi.sa.cz/restapi/payments?dateFrom=2020-01-01&dateTo=2026-01-17&type=CREDIT&type=DIRECT&limit=100
```

**Returns:**
- `paymentId`, `ticketId`, `amount`, `currency`, `method`, `dateTransaction`
- `description` (ticket purchase, cancellation, catering)

## Statistics & Visualizations

### Overview Cards (4 cards, top row)
| Stat | Icon | Description |
|------|------|-------------|
| Total Trips | Train | Count of valid tickets |
| Total Spent | Wallet | Sum of all ticket prices |
| Avg Trip Cost | TrendingUp | Average ticket price |
| Total Travel Time | Clock | Sum of all journey durations |

### Charts & Visualizations

#### 1. Trips by Month (Bar Chart)
- X-axis: Months (Jan 2020 - present)
- Y-axis: Number of trips
- Color: Amber (primary neon)
- Hover: Show exact count + total spent that month

#### 2. Spending Trend (Area Chart)
- X-axis: Months
- Y-axis: Amount in CZK
- Fill: Gradient amber to transparent
- Line: Cyan for cumulative total

#### 3. Most Traveled Routes (Horizontal Bar Chart)
- Top 10 routes (e.g., "Praha → Brno")
- Show trip count + total spent per route
- Color gradient based on frequency

#### 4. City Distribution (Dual Pie/Donut Charts)
- Left: Departure cities distribution
- Right: Arrival cities distribution
- Center: Total trips count
- Colors: Amber/Cyan palette

#### 5. Vehicle Type Distribution (Donut Chart)
- TRAIN vs BUS breakdown
- Show percentage and count

#### 6. Day of Week Heatmap
- 7 columns (Mon-Sun)
- Show trip frequency per day
- Glow intensity based on count

#### 7. Time of Day Distribution (Histogram)
- 24 bars (hours 0-23)
- Group departures by hour
- Identify peak travel times

#### 8. Seat Class Distribution (Stacked Bar)
- LOW_COST vs Standard vs Business (if applicable)
- Show cost savings potential

#### 9. Payment Method Breakdown (Pie Chart)
- ONLINE_PAYMENT, CREDIT_CARD, ACCOUNT
- Show percentage of each

#### 10. Travel Calendar Heatmap
- GitHub-style contribution graph
- Each cell = one day
- Color intensity = trip count
- Show full year view

### Additional Stats (Cards/Metrics)
- **Longest Trip**: Route with max duration
- **Most Expensive Trip**: Highest single ticket price
- **Busiest Month**: Month with most trips
- **Favorite Route**: Most frequently traveled
- **Total Distance**: Estimated km (if calculable from route data)
- **Cancellation Rate**: % of cancelled tickets
- **Peak Travel Hour**: Most common departure time
- **Weekend vs Weekday**: Travel pattern ratio

## Technical Implementation

### File Structure
```
src/claude-history-dashboard/src/
├── routes/
│   └── regiojet.tsx           # Main page component
├── server/
│   └── regiojet.ts            # Server functions for API + caching
├── components/
│   └── charts/                # Chart components (if reusable)
│       ├── BarChart.tsx
│       ├── PieChart.tsx
│       ├── AreaChart.tsx
│       └── HeatmapCalendar.tsx
└── types/
    └── regiojet.ts            # TypeScript interfaces
```

### Server Functions (`src/server/regiojet.ts`)

```typescript
import { createServerFn } from '@tanstack/react-start'
import { Storage } from '@app/utils/storage'

const storage = new Storage('regiojet-dashboard')

// Fetch all tickets with 1-year cache
export const getRegiojetTickets = createServerFn({ method: 'GET' })
  .handler(async () => {
    return storage.getFileOrPut(
      'tickets/all.json',
      async () => {
        // Paginate through all tickets
        // Return combined array
      },
      '365 days'
    )
  })

// Fetch all payments with 1-year cache
export const getRegiojetPayments = createServerFn({ method: 'GET' })
  .handler(async () => {
    return storage.getFileOrPut(
      'payments/all.json',
      async () => { /* fetch and paginate */ },
      '365 days'
    )
  })

// Compute statistics from cached data
export const getRegiojetStats = createServerFn({ method: 'GET' })
  .handler(async () => {
    const [tickets, payments] = await Promise.all([
      getRegiojetTickets(),
      getRegiojetPayments()
    ])
    return computeStats(tickets, payments)
  })
```

### Caching Strategy (IMPORTANT)
- Cache directory: `~/.genesis-tools/regiojet-dashboard/cache/`
- TTL: 365 days (per user requirement)
- Cache keys:
  - `tickets/all.json` - ALL tickets in one file
  - `payments/all.json` - ALL payments in one file

**First-time fetch behavior:**
1. Server function checks if cache exists and is valid
2. If NO cache: Paginate through ENTIRE API history (all years)
3. Combine all pages into ONE JSON array
4. Save to cache file
5. Return data

**Subsequent fetches:**
- Return cached data instantly (no API calls)
- Cache valid for 365 days

**Manual refresh:**
- "Refresh Data" button on UI
- Calls `forceRefreshData()` server function
- Deletes cache files and re-fetches everything
- Updates cache with fresh data

### API Pagination (Aggressive - Fetch Everything)
Strategy for fetching ALL historical data:
1. Use large page size: `limit=500` (or max allowed)
2. Start with `offset=0`
3. Loop: fetch page, if `response.length === limit` → continue with `offset += limit`
4. Stop when `response.length < limit` (last page)
5. Combine ALL pages into single array before caching

```typescript
async function fetchAllPaginated<T>(baseUrl: string, headers: Headers): Promise<T[]> {
  const allData: T[] = []
  let offset = 0
  const limit = 500  // Large batch size

  while (true) {
    const url = `${baseUrl}&limit=${limit}&offset=${offset}`
    const response = await fetch(url, { headers })
    const page = await response.json() as T[]

    allData.push(...page)

    if (page.length < limit) break  // Last page
    offset += limit
  }

  return allData  // Single combined array
}
```

**Result: One API session fetches EVERYTHING, then cached for 1 year.**

### TypeScript Interfaces

```typescript
interface RegiojetTicket {
  id: number
  ticketCode: string
  price: number
  currency: string
  state: 'VALID' | 'CANCELLED' | 'USED'
  seatClassKey: string
  routeSections: Array<{
    section: {
      vehicleType: 'TRAIN' | 'BUS'
      line: { code: string; from: string; to: string }
      departureCityName: string
      departureTime: string
      arrivalCityName: string
      arrivalTime: string
      services: string[]
    }
  }>
}

interface RegiojetPayment {
  paymentId: number
  ticketId: number | null
  amount: number
  currency: string
  method: 'ONLINE_PAYMENT' | 'CREDIT_CARD' | 'ACCOUNT'
  dateTransaction: string
  description: string
}

interface RegiojetStats {
  totalTrips: number
  totalSpent: number
  avgTripCost: number
  totalTravelMinutes: number
  tripsByMonth: Record<string, number>
  spendingByMonth: Record<string, number>
  routeCounts: Record<string, { count: number; spent: number }>
  departureCities: Record<string, number>
  arrivalCities: Record<string, number>
  vehicleTypes: Record<string, number>
  dayOfWeekCounts: number[]
  hourOfDayCounts: number[]
  seatClassCounts: Record<string, number>
  paymentMethods: Record<string, number>
  dailyActivity: Record<string, number>
}
```

### Chart Implementation Approach
Since no chart library is installed, implement charts using:
1. **CSS + Tailwind**: Flexbox-based bars, CSS gradients
2. **SVG**: For pie/donut charts and area charts
3. **CSS Grid**: For calendar heatmap

This matches the existing stats.tsx approach (div-based bar charts).

### Route Definition (`src/routes/regiojet.tsx`)

```typescript
export const Route = createFileRoute('/regiojet')({
  component: RegiojetPage,
  loader: async () => {
    const stats = await getRegiojetStats()
    return { stats }
  },
})
```

### Navigation Update
Add link to Header.tsx:
```tsx
<Link to="/regiojet">Regiojet</Link>
```

## UI Design Guidelines (Cyberpunk Theme)

### Colors
- Primary Neon: `var(--neon-primary)` - Amber #ff9500
- Secondary Neon: `var(--neon-secondary)` - Cyan #00f0ff
- Background: `var(--bg-primary)` - Deep dark
- Cards: `var(--bg-secondary)` with glass effect

### Effects to Apply
- `glass-card` class on main containers
- `neon-border` on stat cards
- `gradient-text` on main heading
- Subtle `animate-fade-in-up` on load
- Glow effects on interactive elements

### Layout
- Max width: 7xl (1280px)
- Grid: 4 cols for overview stats
- 2-column layout for charts on desktop
- Full-width for large visualizations (calendar, trends)

## Implementation Steps

1. **Create types file** (`src/types/regiojet.ts`)
   - Define all TypeScript interfaces

2. **Create server functions** (`src/server/regiojet.ts`)
   - Implement API fetching with pagination
   - Add caching with Storage class
   - Create stats computation function

3. **Create chart components** (`src/components/charts/`)
   - BarChart (horizontal and vertical variants)
   - PieChart/DonutChart (SVG-based)
   - AreaChart (SVG path-based)
   - HeatmapCalendar (CSS grid)

4. **Create main page** (`src/routes/regiojet.tsx`)
   - Layout with all stat cards
   - Integrate all chart components
   - Add refresh data button
   - Apply cyberpunk styling

5. **Update navigation** (`src/components/Header.tsx`)
   - Add Regiojet link to nav

6. **Testing & Polish**
   - Test with real API data
   - Verify caching works
   - Polish animations and responsiveness

## Critical Files to Modify

| File | Action |
|------|--------|
| `src/routes/regiojet.tsx` | CREATE - Main page |
| `src/server/regiojet.ts` | CREATE - Server functions |
| `src/types/regiojet.ts` | CREATE - TypeScript types |
| `src/components/Header.tsx` | MODIFY - Add nav link |
| `src/components/charts/*.tsx` | CREATE - Chart components |

## Verification Plan

1. **API Access**: Verify bearer token works and data fetches correctly
2. **Caching**: Check `~/.genesis-tools/regiojet-dashboard/cache/` for cached files
3. **Stats Computation**: Console log computed stats before rendering
4. **Chart Rendering**: Verify all charts display with sample data
5. **Responsiveness**: Test on mobile/tablet breakpoints
6. **Theme Consistency**: Compare with existing stats.tsx styling

## Dependencies

No new dependencies required. Using:
- Existing TanStack Start infrastructure
- Existing Storage utility from `@app/utils/storage`
- Native SVG for charts
- Tailwind CSS for styling
