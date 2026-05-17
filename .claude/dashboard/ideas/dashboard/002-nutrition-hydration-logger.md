# 002 - Nutrition & Hydration Logger

## Overview
An event-based nutrition and hydration tracking system that logs meals, snacks, and drinks throughout the day. Provides nutritional analytics, pattern detection, and correlations with sleep quality, energy levels, and mood. Emphasizes quick logging without strict calorie counting, focused on behavioral patterns and health insights.

## Purpose & Goals
- Track eating and drinking patterns without friction or strict dietary restrictions
- Identify behavioral patterns: breakfast frequency, caffeine timing, hydration levels
- Detect correlations: "Caffeine after 2pm ruins your sleep" or "Skipping breakfast 3x/week but perform better when you eat early"
- Provide nutritional awareness through visualization and insights
- Support health goals through data-driven recommendations

## Key User Flows

### 1. Quick Food/Drink Logging
- User sees floating action button or quick-add from any page
- Minimal entry: Photo or name of food + optional notes
- Optional: Add nutritional data (calories, macros) if user wants to track
- Auto-complete for common items (coffee, water, lunch, etc.)
- Timestamp auto-set to current time
- Confirm with 1-2 taps

### 2. Viewing Nutrition Dashboard
- Daily view: timeline of all meals/drinks today
- Weekly view: which days did you skip breakfast? How much water?
- Monthly view: trends in meal frequency, eating windows
- Heatmap: when do you typically eat? (breakfast at 7am vs 9am patterns)
- Category breakdown: how many meals, snacks, drinks per day?

### 3. Detailed Nutrition Insights
- "You skip breakfast 3x/week"
- "Average caffeine consumed: 2 cups/day at 8am and 2pm"
- "Typical eating window: 7am-9pm"
- "You eat dinner latest on weekends (9:30pm average)"
- "On days you drink <1L water, energy drops 20%"

### 4. Correlation Analysis
- "Caffeine after 2pm correlates with 1.5-hour longer sleep latency"
- "High protein breakfast days: 40% more focus in morning"
- "Skipped lunch days: mood drops 15% in afternoon"
- Suggests experiments: "Try eating breakfast tomorrow to see if mood improves"

### 5. Nutritional Tracking (Optional)
- Users can optionally log calories/macros
- Daily target vs. actual (pie chart)
- Macro breakdown (protein/carbs/fat percentages)
- Not required—food photography and name logging works without nutrition data

## Data Model

```typescript
interface MealLog {
  id: string
  userId: string
  dateTime: DateTime
  mealType: "breakfast" | "lunch" | "dinner" | "snack" | "drink"
  name: string // "Coffee", "Chicken sandwich", "Water"
  quantity?: string // "2 cups", "1 plate", etc.
  notes?: string // "Black coffee no sugar", "Felt hungry after"

  // Optional nutrition data
  nutrition?: {
    calories?: number
    protein?: number // grams
    carbs?: number // grams
    fat?: number // grams
    fiber?: number // grams
    caffeine?: number // mg (for drinks)
  }

  // Optional
  photo?: string // image URL
  moodBefore?: number // 1-5 scale
  energyBefore?: number // 1-5 scale

  tags?: string[] // "organic", "homemade", "restaurant"
  createdAt: DateTime
  updatedAt: DateTime
}

interface NutritionGoal {
  id: string
  userId: string
  goalType: "calorie" | "protein" | "water" | "meals-per-day"
  targetValue: number
  createdAt: DateTime
}
```

## UI Components

### Quick Log Card
- Floating action button with "+" icon
- Modal/sheet that opens with minimal fields:
  - Meal type selector (breakfast/lunch/dinner/snack/drink)
  - Food name input with autocomplete
  - Optional quantity field
  - Optional notes
  - Optional nutrition data (collapsible section)
  - Submit button
- Takes <15 seconds to log basic entry

### Nutrition Dashboard Page
- Tabs: Daily | Weekly | Monthly | Insights | Goals
- Daily tab:
  - Time-ordered list of today's meals/drinks
  - Quick stats: Total meals (3), Total drinks (5), Estimated calories (if tracked)
  - Quick add button always visible
  - Timeline view with meal types color-coded (breakfast=orange, lunch=green, etc.)
- Weekly tab:
  - 7-day calendar showing meal patterns
  - Heatmap of eating windows (when do meals typically occur?)
  - Days with/without breakfast highlighted
  - Meals per day comparison
- Monthly tab:
  - 30-day heatmap showing frequency
  - Trend lines for meal frequency, drinking patterns
  - Best/worst eating weeks highlighted
- Insights tab:
  - Pattern cards: "You skip breakfast 3x/week"
  - Correlation cards: "Caffeine after 2pm affects sleep"
  - Suggestions: "Try eating within 1 hour of waking for energy boost"
- Goals tab:
  - Current goals with progress (if user tracks calories/macros)
  - Water intake tracker (simple: 8 glasses/day target)
  - Meal frequency goal: "Aim for 3 meals + 1 snack daily"

### Nutrition Stats Widget
- Daily: meal count, total calories (optional), caffeine total
- Weekly: average meals/day, most common meal times
- Monthly: trends, patterns, correlations

## Integration Points

**Sleep Tracker Integration:**
- Show "Caffeine timeline vs. Sleep quality" graph
- Alert: "You logged caffeine at 4pm. Last 3 times you did this, sleep quality was lower"
- Recommendation: "Avoid caffeine after 2pm to improve sleep"

**Mood & Energy Tracker Integration:**
- Overlay nutrition timeline with mood/energy dips
- "On days you skip breakfast, afternoon mood is 2 points lower"
- Suggest correlation experiments

**Activity Log Integration:**
- Show meals in timeline alongside other activities
- "Heavy workout → Ate larger lunch → Energy stayed high all afternoon"

**Accountability Network Integration:**
- Share nutrition goals with accountability partner
- "We both committed to drinking 2L water daily"
- Shared progress tracking

## Success Criteria

- Quick logging: <20 seconds for typical entry
- System identifies 2-3 eating patterns within 1 week of data
- Correlations between nutrition and mood/sleep are detectable after 2 weeks
- Users understand their typical eating windows and meal frequency
- Optional nutrition tracking doesn't interfere with basic event logging

## Technical Considerations

- Auto-complete database of common foods
- Fast search for meal logging
- Photo analysis optional (if adding image recognition later)
- Correlation calculations similar to sleep tracking (statistical analysis)
- Heatmap visualization for eating windows (24-hour day view)
- Timezone awareness for daily boundaries

## Error Handling

- Invalid dates prevented
- Future dates not allowed (but allow backdating for accuracy)
- Auto-complete prevents typos
- Nutrition fields optional (user can ignore them)
- Duplicate entries on same day: allowed (multiple meals expected)

## Privacy Considerations

- Photos stored locally or with user consent only
- Nutrition data never shared unless explicitly enabled in goals
- No AI-based analysis of meals without explicit opt-in
- All data owned by user, exportable

## Related Features

- Feeds into Health Dashboard (sleep + nutrition + energy overview)
- Correlates with Mood & Energy Tracker
- Could integrate with Portfolio/Skills (nutrition for athletes/performers)
- Supports Accountability Network (shared nutrition goals)

## Open Questions

1. Should we integrate with food databases (USDA, MyFitnessPal) for auto-nutrition data?
2. How granular should portion tracking be?
3. Should we allow barcode scanning for packaged foods?
4. How to handle eating at restaurants without full nutrition info?
