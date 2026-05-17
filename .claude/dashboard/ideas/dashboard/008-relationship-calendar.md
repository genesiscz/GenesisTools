# 008 - Relationship Calendar

## Overview
A relationship maintenance system that reminds users about important dates and encourages regular connection with people they care about. Provides calendar view of birthdays, anniversaries, and check-in deadlines, suggests thoughtful actions, tracks relationship health through frequency of contact, and integrates with accountability partners for shared social activities.

## Purpose & Goals
- Prevent important relationships from fading due to busy life
- Maintain awareness of important dates (birthdays, anniversaries)
- Suggest proactive outreach before relationships need maintenance
- Track relationship health through contact frequency
- Enable collaborative social events and gatherings
- Reduce guilt about staying connected
- Celebrate important people in life

## Key User Flows

### 1. Add Person to Relationships
- User adds person they care about
- Fields:
  - Name and optional photo
  - Relationship type (friend, family, partner, mentor, colleague, etc.)
  - Important dates (birthday, anniversary, meeting date)
  - Contact frequency goal ("Check in weekly", "Monthly", etc.)
  - Preferred contact methods (call, text, coffee, dinner, etc.)
  - Notes about shared interests
- System sets reminders

### 2. Calendar View
- Monthly calendar showing:
  - Important dates highlighted (birthdays, anniversaries)
  - Check-in deadlines marked
  - Personal events and gatherings
- Different colors for different relationship types
- Hovering on date shows who/what event
- Click to see relationship details and suggested actions

### 3. Relationship Check-In
- System reminds: "Haven't chatted with [Person] in 3 weeks. Check in?"
- Quick action suggestions:
  - "Call for 15 minutes"
  - "Send a message"
  - "Suggest coffee this weekend"
  - "Schedule video call"
- User logs check-in: records contact
- Can attach note: "Caught up on their new job"

### 4. Important Date Notifications
- Birthday approaching: "Sarah's birthday in 3 days"
- Suggestions: "Send a card", "Plan dinner", "Order a gift"
- Anniversary: "Your 5-year friendship anniversary with Marcus!"
- Custom date reminders: "Date night scheduled for Saturday"

### 5. Relationship Health Dashboard
- List of important relationships
- Health indicator: "Healthy" (recent contact), "Attention needed" (overdue), "Strong" (frequent contact)
- Last contact date for each person
- Days until next important date
- Quick contact button (call, text, email)
- Upcoming dates this month

### 6. Group Events & Gatherings
- Create or join shared events with accountability partners
- "Birthday party for James - June 15"
- "Group hike next Saturday"
- Collaborative planning: todos, expense splitting (optional)
- RSVP tracking
- Post-event: group photo sharing, recap

## Data Model

```typescript
interface Relationship {
  id: string
  userId: string
  name: string
  photoUrl?: string
  relationshipType: RelationshipType // "friend", "family", "partner", "mentor", "colleague"
  email?: string
  phone?: string
  socialMedia?: Array<{
    platform: string // "instagram", "twitter", "linkedin"
    handle: string
  }>

  // Important dates
  importantDates?: Array<{
    label: string // "birthday", "anniversary", "wedding_date"
    date: DateTime
  }>

  // Contact goals
  checkInFrequencyDays?: number // Check in every X days (null = no goal)
  preferredContactMethods?: string[] // ["call", "text", "coffee", "dinner"]
  lastContactDate?: DateTime
  lastContactMethod?: string

  // Relationship notes
  sharedInterests?: string[] // ["hiking", "cooking", "gaming"]
  notes?: string
  anniversaryOfFriendship?: DateTime // When did you meet?

  // Shared with accountability partner
  sharedWith?: string[] // userIds

  createdAt: DateTime
  updatedAt: DateTime
}

type RelationshipType = "friend" | "family" | "partner" | "mentor" | "colleague" | "acquaintance"

interface CheckIn {
  id: string
  userId: string
  relationshipId: string
  dateTime: DateTime
  method: "call" | "text" | "email" | "coffee" | "dinner" | "video_call" | "in_person" | "other"
  notes?: string
  duration?: number // minutes (for calls/coffee)
  photo?: string // Optional photo from meeting
  createdAt: DateTime
}

interface RelationshipEvent {
  id: string
  userId: string
  title: string
  description?: string
  dateTime: DateTime
  relatedPeople?: string[] // relationshipIds
  eventType: "birthday" | "anniversary" | "gathering" | "milestone" | "other"
  location?: string
  isPublic: boolean

  // For shared events with accountability partners
  sharedWith?: string[] // userIds
  attendees?: string[] // People attending
  rsvpStatus?: Map<string, "yes" | "no" | "maybe">

  // Expense sharing (optional)
  sharedExpenses?: Array<{
    description: string
    amount: number
    paidBy: string // userId
  }>

  createdAt: DateTime
  updatedAt: DateTime
}

interface CheckInReminder {
  id: string
  userId: string
  relationshipId: string
  dueDate: DateTime
  status: "pending" | "completed" | "dismissed"
  createdAt: DateTime
}
```

## UI Components

### Add Relationship Modal
- Simple form with fields:
  - Name input
  - Photo upload (optional)
  - Relationship type selector
  - Birthday/anniversary date picker
  - Check-in frequency dropdown
  - Preferred contact methods (multi-select)
  - Shared interests (tags)
  - Notes textarea
- Save button

### Relationship Calendar Page
- Full month view (like Google Calendar)
- Different colors for relationship types:
  - Blue = Friends
  - Red = Family
  - Pink = Partner
  - Green = Mentors
  - Gray = Colleagues
- Important dates appear as events
- Check-in reminders appear as notifications on calendar
- Click date to see all people/events
- Hover on event to see quick preview
- Small "Mark complete" button for check-in reminders

### Relationship List/Dashboard
- Tabs: Overview | Calendar | People | Events | Check-ins
- Overview tab:
  - Quick stats: "10 relationships", "Contacted 4 this week"
  - Upcoming important dates (next 30 days)
  - People needing check-in soon (overdue list)
  - Next birthday/anniversary
  - Monthly check-in goal progress
- People tab:
  - List of all relationships
  - Each person card shows:
    - Name and photo
    - Relationship type
    - Last contact: "3 weeks ago"
    - Days since last contact
    - Next important date
    - Health indicator: 🟢 Healthy / 🟡 Overdue / 🔴 Urgent
    - Quick action buttons: Call, Text, Email, Log Check-in
- Events tab:
  - Upcoming events and gatherings
  - Past events (photos, recaps)
  - Create new event button
- Check-ins tab:
  - History of all check-ins with dates and methods
  - Grouped by person or chronologically
  - Notes and photos visible

### Relationship Detail Page
- Relationship name and photo
- Quick stats:
  - Last contact: "3 weeks ago"
  - Contact frequency: "Check in every 2 weeks"
  - Relationship duration: "Friends for 5 years"
  - Next important date: "Birthday - June 15 (25 days)"
- Contact methods and social media links
- Timeline of check-ins (latest first)
- Shared interests
- Notes section
- Shared events (if accountability partner involved)
- Quick actions: Call, Text, Email, Log Check-in, Schedule Call

### Check-In Modal
- Quick logging after contacting someone
- Fields:
  - Contact method (call, text, coffee, dinner, etc.)
  - Duration (if call/in-person)
  - Notes about conversation
  - Optional photo
- Auto-populates current date/time
- Submit button
- Confirmation with next suggested check-in date

### Check-In Reminder Card
- Push notification or in-app notification
- "Haven't talked to Sarah in 2 weeks. Check in?"
- Suggested actions:
  - "Call for 15 min"
  - "Send message"
  - "Schedule coffee"
  - "Dismiss for 1 week"
- Quick action buttons

### Shared Event Card (Accountability Partners)
- Event title and date
- Location
- Invited attendees
- RSVP status for you
- Shared expense breakdown (if applicable)
- "View event details" link
- Post-event: photo gallery, recap notes

### Health Indicator
- Visual status for each relationship:
  - 🟢 Healthy: Recent contact, on schedule
  - 🟡 Overdue: Overdue for check-in
  - 🔴 Urgent: Very overdue, relationship at risk
- Hover shows: "Last contact: 3 weeks ago, Goal: every 2 weeks"

## Integration Points

**Accountability Network:**
- Create shared social events with accountability partner
- "Let's both call our parents this weekend"
- Partner can see your relationship calendar
- Group activities count toward social goals

**Calendar/Planning:**
- Events appear in main dashboard calendar
- Important dates sync with personal calendar (optional)
- Reminders appear as calendar notifications

**Activity Log:**
- Check-ins appear in activity timeline
- "Had coffee with Sarah", "Called mom"
- Shows social engagement metrics

**Mood & Energy Tracker:**
- Social activities can affect mood/energy
- "Social time energizes you: +1.2 energy"
- Suggests scheduling social time when energy is low

**Mood/Energy Tracker Integration:**
- "You're more energized after seeing friends"
- Suggestion: "Schedule time with Sarah—you said it energizes you"

## Success Criteria

- Users don't let important relationships fade
- Important dates never missed
- Check-in reminders feel helpful, not nagging
- Relationship health is visible at a glance
- Contact logging is quick and easy (<1 minute)
- Shared events with partners are seamless

## Technical Considerations

- Calendar visualization (month view, color coding)
- Reminder scheduling and notifications
- Check-in frequency calculations
- Important date notifications
- Time zone awareness for all dates
- Optional: integration with calendar apps (Google Calendar, Apple Calendar)

## Error Handling

- Duplicate relationships: warn user
- Invalid dates: prevent future dates for past events
- Missing contact method: allow logging without it
- Overdue check-ins: don't penalize, just suggest
- Event attendee RSVP: handle non-responses gracefully

## Privacy Considerations

- Relationship data private by default
- Sharing with accountability partner optional
- Shared events explicit opt-in
- Photos require permission to share
- Can block certain people from seeing your calendar

## Relationship Insights (Future)

- "You check in more frequently with friends vs. family"
- "Your social time is concentrated on weekends"
- "You maintain 12 active relationships"
- Suggestions for relationship improvement

## Related Features

- Integrates with Accountability Network for social goals
- Feeds into Mood & Energy Tracker (social interaction effects)
- Activity Log shows social engagement
- Can link to Portfolio (professional relationships/networking)

## Open Questions

1. Should we integrate with actual calendar apps (Google Calendar, Apple Calendar)?
2. Should we allow groups/family relationships (multiple people at once)?
3. Should we send automated reminder messages on their behalf?
4. Should relationship history be searchable/archived?
5. Should we track relationship sentiment (conversation quality)?
