# 012 - Event Coordination Hub

## Overview
A collaborative event planning and coordination system that enables users to organize gatherings, manage attendees, coordinate logistics, track expenses, and capture memories. Integrates with accountability partners, relationship calendar, and activity log to create a complete event lifecycle experience from planning through post-event reflection.

## Purpose & Goals
- Simplify event planning and coordination
- Enable collaborative planning with friends and accountability partners
- Track event expenses and participant contributions
- Manage attendee RSVPs and preferences
- Coordinate logistics: location, time, materials, tasks
- Capture and share event memories
- Enable post-event reflection and feedback
- Connect events to relationships and social goals

## Key User Flows

### 1. Create Event
- User creates event with details:
  - Event name ("Birthday party for James", "Group hike", "Book club meeting")
  - Description and purpose
  - Date and time (or time range for flexibility)
  - Location
  - Event type (birthday, gathering, trip, celebration, activity, etc.)
  - Estimated attendee count
  - Invite list (select from contacts/accountability partners)
  - Special details (dietary restrictions, skill levels, etc.)
- System generates event page with RSVP link

### 2. RSVP & Attendee Management
- Invitees receive invite (in-app or email)
- Can RSVP: Yes, No, Maybe, with optional message
- Attendees see updated attendee list (privacy: name only or full details?)
- Organizer can see dietary restrictions, special needs
- Reminder notifications for pending RSVPs
- Final headcount for planning

### 3. Event Coordination
- To-do list for event preparation
- Divided by category: setup, food, activities, logistics
- Task assignment to volunteers
- Progress tracking (% complete)
- Collaborative checklist (anyone can update)
- Shared notes and planning documents
- Decision tracking: "Voted: pizza vs. sandwiches"

### 4. Expense Tracking
- Log event expenses as incurred
- "Purchased decorations: $25"
- "Pizza delivery: $80"
- Track who paid for what
- Calculate per-person cost
- Show who owes whom money
- Optional: expense splitting calculator
- Settlement tracking: who paid back

### 5. Event Day Timeline
- Shared timeline showing schedule
- Arrival times and guest activities
- Real-time updates: "Sarah just arrived"
- Photo uploads during event
- Comments and reactions
- Event highlights captured

### 6. Post-Event Memories
- Photo gallery from event
- Video clips/moments
- Guest contributions (photos attendees took)
- Event recap: highlights and key moments
- Guest feedback/testimonials
- Memory archive for later viewing

### 7. Event Reflection & Feedback
- Quick survey: "How was the event?" (rating + optional comment)
- "What was your favorite part?"
- Photo highlights: best moments
- Budget review: actual vs. planned
- Lessons learned: "Next time do X differently"
- Archive successful events as templates

## Data Model

```typescript
interface Event {
  id: string
  organizerId: string // User who created event
  title: string
  description?: string
  eventType: EventType // "birthday", "gathering", "trip", "celebration", "activity", "meeting", "other"
  startDate: DateTime
  endDate?: DateTime // For multi-day events
  location?: string
  address?: string // Full address for mapping

  // Attendees
  invitees: string[] // User IDs or emails
  attendees: Array<{
    userId: string
    rsvpStatus: "yes" | "no" | "maybe"
    rsvpDate: DateTime
    dietaryRestrictions?: string
    specialNeeds?: string
    notes?: string
  }>
  expectedAttendeeCount?: number

  // Planning
  isPublic: boolean // Visible to all invited or private
  isSharedEvent: boolean // With accountability partners
  collaborators: string[] // Other organizers

  // Timeline
  createdAt: DateTime
  updatedAt: DateTime
  status: "planning" | "confirmed" | "active" | "completed" | "canceled"
}

type EventType = "birthday" | "gathering" | "trip" | "celebration" | "activity" | "meeting" | "other"

interface EventTask {
  id: string
  eventId: string
  title: string
  description?: string
  category: "setup" | "food" | "activities" | "logistics" | "cleanup"
  assignedTo?: string // userId
  dueDate?: DateTime
  isCompleted: boolean
  completedBy?: string
  completedAt?: DateTime
  subtasks?: Array<{
    title: string
    isCompleted: boolean
  }>
  priority: "low" | "medium" | "high"
  createdAt: DateTime
}

interface EventExpense {
  id: string
  eventId: string
  description: string
  amount: number
  paidBy: string // userId
  date: DateTime
  category: "food" | "decorations" | "venue" | "entertainment" | "other"
  attendeesInvolved?: string[] // Who to split cost among
  notes?: string
  receipt?: string // URL to receipt photo
  createdAt: DateTime
}

interface EventMemory {
  id: string
  eventId: string
  type: "photo" | "video" | "note" | "testimonial"
  content: string // File URL or text content
  uploadedBy: string // userId
  caption?: string
  timestamp?: DateTime // When during event
  likes?: string[] // userIds who liked
  comments?: Array<{
    userId: string
    text: string
    timestamp: DateTime
  }>
  isHighlight: boolean // Feature as key memory
  createdAt: DateTime
}

interface EventFeedback {
  id: string
  eventId: string
  userId: string // Who gave feedback
  rating: 1 | 2 | 3 | 4 | 5
  favoritePartResponse?: string
  lessonsLearned?: string
  wouldAttendAgain?: boolean
  notes?: string
  submittedAt: DateTime
}

interface EventTemplate {
  id: string
  userId: string
  basedOnEventId?: string
  name: string // "Birthday party template"
  defaultTasks: string[] // Task list copied from template
  defaultExpenses?: Array<{ description: string, estimatedAmount: number }>
  notes?: string
}
```

## UI Components

### Create Event Modal
- Multi-step form (or single scrolling)
- Step 1: Basic info (title, type, date, time, location)
- Step 2: Invite attendees (select from contacts, email addresses)
- Step 3: Special details (dietary, accessibility, notes)
- Step 4: Review and create
- Preview of event page before publishing
- Save as template option

### Event Detail Page
- Event header: title, date, time, location
- Tabs: Overview | Attendees | Planning | Expenses | Gallery | Feedback
- Overview tab:
  - Event description
  - Countdown to event
  - RSVP status (Yes: 12, Maybe: 3, No: 2)
  - Quick stats: confirmed attendees, total expenses so far
  - Collaborative planning status
  - Share event link button
- Attendees tab:
  - List of invited guests
  - RSVP status for each
  - Accept/remind buttons for pending responses
  - Attendee notes: dietary restrictions, special needs
  - Filter by RSVP status
  - Export attendee list
- Planning tab:
  - Collaborative to-do checklist
  - Grouped by category (setup, food, activities, cleanup)
  - Each task shows:
    - Task name and description
    - Assigned to (person or "Volunteer needed")
    - Due date
    - Completion status
    - Subtasks
  - Mark complete button
  - Priority indicators
  - Progress bar: X of Y tasks complete
  - Shared notes/documents
  - Voting on decisions: "Pizza vs. sandwiches"
- Expenses tab:
  - List of all expenses logged
  - Each shows: description, amount, paid by, category
  - Total event cost
  - Per-person split
  - Who owes whom (if uneven contribution)
  - Add expense button
  - Settlement tracker
  - Budget vs. actual (if budget set)
- Gallery tab:
  - Photo grid of all event memories
  - Uploaded by (credit photographer)
  - Chronological or highlight-first view
  - Add/upload more photos button
  - Comments on photos
  - Mark as favorite/highlight
  - Archive/delete photos
  - Create slideshow
- Feedback tab:
  - Survey results (if event completed)
  - Ratings breakdown
  - Feedback comments
  - Lessons learned
  - Would attend again % (if celebration type)

### Attendee Card
- Name/avatar
- RSVP status (Yes 🟢, No 🔴, Maybe 🟡)
- Date RSVPed
- Dietary restrictions/special needs shown
- Quick message button
- Remind button (if no RSVP)

### Event Task Card
- Task title and description
- Category badge
- Assigned to (or "Need volunteer")
- Due date and priority indicator
- Completion checkbox
- Progress on subtasks (3/5 done)
- Click to expand and see details
- Comments/notes section

### Expense Tracker
- Running total prominently displayed
- Table of all expenses:
  - Description
  - Amount
  - Paid by (person avatar)
  - Category
  - Date
- Add expense button
- Settlement summary:
  - Per-person split
  - Who paid extra/is owed
  - "You paid $50 extra" or "You owe $10"

### Event Timeline/Gallery
- Chronological view of photos/videos
- Each item shows upload time and photographer
- Ability to comment and like
- Highlight key moments
- Create gallery/slideshow view
- Download/share option

### Post-Event Feedback Modal
- Quick survey after event:
  - "How was the event?" (5-star rating)
  - "What was your favorite part?" (open text)
  - "Would you attend again?" (yes/no)
  - "Any suggestions for next time?" (open text)
- Optional: submit feedback button
- Skip option

### Event Widget
- Dashboard shows upcoming events
- "Next event: Sarah's birthday - June 15"
- Your tasks pending
- Pending RSVPs to send
- Link to event details

### Event Calendar View
- Monthly calendar showing all events
- Different colors for event types
- Click event to view details
- Quick RSVP button
- Attendee count shown
- Countdown to upcoming events

## Integration Points

**Relationship Calendar:**
- Events linked to people you care about
- Birthday events auto-created (reminder to plan)
- Event attendees appear in relationship calendar
- Post-event: contact logged as "met for [event]"

**Accountability Network:**
- Create shared events with accountability partner
- "Let's plan a group hike together"
- Partner sees event and can co-organize
- Collaborative planning between partners

**Activity Log:**
- Event attendance logged as major activity
- "Attended Sarah's birthday party"
- Photos appear in activity timeline
- Event memories integrated

**Spending Tracker:**
- Event expenses appear in spending history
- "Event expenses: $120" aggregated
- Can allocate spending to savings goals
- Budget planning connected to spending goals

**Calendar Integration:**
- Events appear in main dashboard calendar
- Optional: sync to Google Calendar/Apple Calendar
- Reminders and notifications

## Success Criteria

- Event creation takes <5 minutes
- Collaboration is intuitive for multiple organizers
- Expense tracking is simple and accurate
- RSVP process is easy for attendees
- Photo sharing and memories are seamless
- Post-event feedback is captured for improvement
- Users feel connected through shared event experience

## Technical Considerations

- Real-time collaboration (WebSocket for live updates)
- Event invitation system (email + in-app)
- Expense calculation and splitting
- Photo upload and storage optimization
- Comment/like real-time updates
- Calendar integration APIs
- Notification system for RSVPs, tasks, reminders

## Error Handling

- Invalid dates prevented (past dates, end before start)
- RSVP duplicates: update existing not create new
- Expense math: validate positive amounts
- Attendee deletion: confirm before removing
- Event cancellation: notify all attendees
- Image upload: size/format validation

## Privacy Considerations

- Attendee lists visible only to invited
- Shared event data limited (attendees, photos, feedback)
- Can control photo visibility (private/attendees only/public)
- Budget details visible only to organizer/co-organizers
- Dietary restrictions visible only to organizers

## Gamification Elements (Optional)

- Event planning streaks: consecutive events organized
- "Party planner" badge for hosting events
- Photo upload achievements: "Captured the moment"
- Expense splitter hero: managed complex splits perfectly

## Related Features

- Relationship Calendar: event planning for important people
- Accountability Network: collaborative event planning
- Activity Log: event attendance and memories
- Spending Tracker: event expenses and budgeting
- Mood & Energy: social events affect mood/energy

## Open Questions

1. Should we support calendar-style scheduling tools (drag to reschedule)?
2. Should we have a shared wishlist for gift events?
3. Should we provide venue/vendor recommendations?
4. Should we integrate with food delivery services for catering?
5. Should we support event mapping (guest travel times)?
