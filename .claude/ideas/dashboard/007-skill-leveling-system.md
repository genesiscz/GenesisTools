# 007 - Skill Leveling System

## Overview
A gamified skill development tracker that visualizes competency growth across technical and soft skills. Users level up skills through consistent practice, tracked project use, deliberate practice logging, and completion of skill-building activities. Provides visual progression, skill trees, proficiency assessments, and integration with portfolio and accountability network for motivated learning.

## Purpose & Goals
- Make skill development visible and rewarding
- Provide clear progression paths: Beginner → Intermediate → Advanced → Expert
- Enable sharing of skill goals with accountability partners
- Integrate with portfolio (projects demonstrate skill levels)
- Recognize and celebrate skill mastery
- Support skill-building goals and milestones
- Show skill evolution over time

## Key User Flows

### 1. Add Skill to Track
- User selects or creates a skill to track
- Optionally sets proficiency goal level
- System assigns starting level based on assessment or self-rating
- Skill appears in "My Skills" list with visual progress

### 2. Log Skill Usage
- Log deliberate practice: "Spent 2 hours on React components"
- Log project work: "Used Python in e-commerce project"
- Log learning: "Completed React hooks course"
- Each activity contributes to skill level progression
- Frequency matters: consistent practice advances faster

### 3. Skill Levels & Assessment
- 5-level system:
  - Beginner (0-25%): Learning fundamentals
  - Novice (25-50%): Practical experience, small projects
  - Intermediate (50-75%): Comfortable with most tasks, leading small work
  - Advanced (75-90%): Expert-level work, mentoring others
  - Expert (90-100%): Mastery, recognized authority
- Users can take assessments to verify level
- Portfolio projects automatically update skill levels
- Skill insights: "React: Advanced (8 projects, 200 hours)"

### 4. Skill Dependencies & Trees
- Some skills build on others: "Python → Data Science → Machine Learning"
- Visual dependency tree showing skill relationships
- "Unlock" skills by reaching certain levels in prerequisites
- Suggested progression paths

### 5. Skill Goals & Milestones
- Set goal: "Reach Advanced in React by December"
- System calculates: "5 more projects at current pace"
- Milestone celebrations when leveling up
- Share skill goal with accountability partner
- "We're both learning React—let's level up together!"

### 6. Practice Streaks & Badges
- Practice streak tracking: "React: 15-day streak"
- Skill badges: earned at level milestones
  - "🏆 React Novice" at 25%
  - "🏆 React Intermediate" at 50%
  - etc.
- Annual skill review: "Your top 3 skills this year"
- Yearly achievements: "Mastered 5 new skills in 2024"

## Data Model

```typescript
interface Skill {
  id: string
  userId: string
  name: string
  category: SkillCategory // "technical", "soft", "creative", "business"
  currentLevel: "beginner" | "novice" | "intermediate" | "advanced" | "expert"
  proficiencyScore: number // 0-100
  targetLevel?: string // Desired level
  targetDate?: DateTime

  // Progression data
  totalHours: number
  projectsUsed: number
  lastPracticedDate: DateTime
  streakDays: number
  streakStartDate: DateTime

  // Proficiency data
  selfAssessmentScore?: number // User's self-assessment
  assessmentResults?: Array<{
    date: DateTime
    score: number
    questions: number
  }>

  // Dependencies
  prerequisiteSkills?: string[] // skillIds
  relatedSkills?: string[]

  createdAt: DateTime
  updatedAt: DateTime
}

type SkillCategory = "technical" | "soft" | "creative" | "business" | "language"

interface SkillActivity {
  id: string
  userId: string
  skillId: string
  activityType: "practice" | "project" | "learning" | "teaching" | "assessment"
  title: string // "Built React component library"
  hoursLogged: number
  description?: string
  sourceFeature?: string // "portfolio", "activity_log", etc.
  proficiencyGain: number // Calculated by system
  createdAt: DateTime
}

interface SkillBadge {
  id: string
  skillId: string
  userId: string
  badgeType: "level_reached" | "streak" | "annual" | "mastery"
  level: string // "beginner", "novice", "intermediate", "advanced", "expert"
  earnedAt: DateTime
}

interface SkillAssessment {
  id: string
  skillId: string
  userId: string
  score: number // 0-100
  questions: number
  correctAnswers: number
  estimatedLevel: string
  completedAt: DateTime
}
```

## UI Components

### Add Skill Modal
- Skill name input with autocomplete
- Category selector (technical, soft, creative, business, language)
- Starting level assessment (optional quiz or self-rating)
- Target level and deadline (optional)
- Save button

### My Skills Dashboard
- Tabs: Overview | Skills | Goals | Badges | Assessments
- Overview tab:
  - Skills ranked by proficiency level
  - Recent activity in each skill
  - Fastest growing skill
  - Current practice streaks
  - Total learning hours
- Skills tab:
  - List of all tracked skills
  - Each skill card shows:
    - Skill name and icon
    - Current level (Beginner/Novice/Intermediate/Advanced/Expert)
    - Progress bar (0-100%)
    - Hours logged
    - Projects using skill
    - Last practiced date
    - Practice streak indicator
    - Trending indicator (↑ if active this week)
    - Click to view details
- Goals tab:
  - Active skill goals
  - Each shows:
    - Skill name
    - Current vs. target level
    - Deadline
    - Progress toward goal
    - Suggested activities: "Practice 2 more projects"
  - Completed skill goals (archive)
- Badges tab:
  - All earned badges displayed
  - Organized by date earned
  - Share badges to portfolio/social
- Assessments tab:
  - History of skill assessments
  - Score and recommended level
  - Option to take new assessment

### Skill Detail Page
- Skill name and category
- Large progress bar (0-100%)
- Current level display
- Statistics:
  - Total hours logged: 120
  - Projects using skill: 5
  - Last practiced: 3 days ago
  - Streak: 12 days
  - First logged: 6 months ago
- Practice streak visual (calendar heatmap)
- Recent activities (practice, projects, learning)
- Related/prerequisite skills
- Suggested next steps
- Skill goal (if set)
- Option to log new activity
- Skill dependency tree (visual)

### Skill Leveling Progress
- Visual progression system:
  - Beginner: 0-25% (flat bar)
  - Novice: 25-50% (bar with 1 segment filled)
  - Intermediate: 50-75% (bar with 2 segments filled)
  - Advanced: 75-90% (bar with 3 segments filled)
  - Expert: 90-100% (full bar, special color)
- Milestone celebrations when leveling up
- Estimated time to next level based on pace

### Skill Tree Visualization
- Network diagram showing skill relationships
- Prerequisites shown as arrows pointing up
- Related skills shown as connections
- Unlocked skills highlighted, locked skills grayed out
- Click to view skill details
- Auto-layout for readability

### Practice Logging Widget
- Quick "Log Practice" button
- Minimal form:
  - Skill selector
  - Activity type (practice/project/learning)
  - Hours spent
  - Description (optional)
  - Submit
- Takes <1 minute to log

### Badges & Achievements
- Achievement cards showing:
  - Badge icon
  - Title: "React Intermediate"
  - Date earned
  - "Share" button for portfolio/social
  - Collectible feel

## Integration Points

**Portfolio System:**
- Projects automatically update skill levels
- "React: 8 projects → Advanced level"
- Portfolio shows skill progression timeline

**Accountability Network:**
- Share skill goals with partners
- "Let's both reach Intermediate in Python"
- Shared progress tracking and leaderboards
- Skill milestone celebrations with partner

**Activity Log:**
- Skill practice appears as activities
- Can tag activities with relevant skills
- "Completed React tutorial: +5 React XP"

**Creative Metrics (for creative skills):**
- Creative output counts as practice
- "Wrote 1000 words: +10 Writing XP"
- Art projects level up design skills

**Job/Freelance Tracking:**
- Client projects update skill usage
- Highest-value skills highlighted
- Portfolio shows most marketable skills

## Success Criteria

- Clear progression visible within days of consistent practice
- Users understand how to advance skills
- Skill levels integrate naturally with portfolio
- Practice logging takes <2 minutes
- Levels feel achievable, not grindy
- Partnership features motivate skill growth

## Technical Considerations

- Proficiency score calculations (weighted by activity type)
- Streak tracking (timezone-aware date comparisons)
- Skill dependency graph (topological sorting)
- XP/points system (optional gamification)
- Assessment quiz database and scoring
- Skill recommendation engine (based on portfolio/interests)

## Error Handling

- Duplicate skill entries: prevent or merge
- Invalid hours: validate positive numbers only
- Assessment scores out of range: sanitize
- Circular dependencies: prevent in skill trees
- Streak breaks: gracefully reset and notify
- Missing prerequisite: warn before advancing

## Gamification Elements (Optional)

- XP points: earn from activities, level up skills
- Streak bonuses: longer streaks = faster progression
- Badges/achievements: visual rewards
- Leaderboards: compete with accountability partners on specific skills
- Prestige system: reset level to earn bonus points after mastery
- Skill mastery celebration: "You've become an expert!"

## Related Features

- Portfolio: skills demonstrated through projects
- Accountability Network: shared skill goals
- Creative Metrics: creative skill advancement
- Activity Log: practice activities tracked
- Job Tracking: freelance work updates skills

## Open Questions

1. Should we have automated skill assessments or user self-assessment?
2. How many skill categories initially vs. user-created skills?
3. Should skill dependencies be strict or just suggestions?
4. Should there be a community skill database?
5. Should XP/points be visible or just levels?
