# 006 - Portfolio & Showcase

## Overview
A professional portfolio builder that enables users to showcase creative work, career achievements, and completed projects. Provides automatic portfolio page generation, portfolio statistics tracking, work gallery with filtering, timeline of accomplishments, and shareable public profile. Integrates with freelance tracking to show earned income per project.

## Purpose & Goals
- Easily upload and organize creative work and professional achievements
- Generate professional portfolio pages automatically (no design skills needed)
- Track portfolio metrics: total projects, skills demonstrated, hours invested
- Show work evolution over time through timeline view
- Create shareable portfolio link for job applications, client pitches, or social sharing
- Connect projects to income earned (for freelancers)
- Showcase impact: users served, products shipped, downloads, etc.

## Key User Flows

### 1. Add Project to Portfolio
- User navigates to Portfolio section
- Clicks "Add Project" button
- Form with fields:
  - Project title ("E-commerce redesign", "Mobile app launch")
  - Description (optional short description)
  - Project category (design, code, writing, music, video, photography, etc.)
  - Cover image/gallery (multiple images)
  - URL/link to live project or demo
  - Tools/technologies used (tags)
  - Start and end date
  - Impact/stats (users, revenue, downloads, etc.)
  - Skill tags demonstrated
- Auto-generates portfolio preview
- Mark as "active work" or "completed"

### 2. Browse Portfolio Gallery
- Gallery view with thumbnails of all projects
- Filter by category (design, development, writing, etc.)
- Filter by skills demonstrated (React, Python, Figma, etc.)
- Sort by date, popularity, or impact
- Search by keyword
- Click project to see full details

### 3. Portfolio Statistics
- Total projects: 24
- Total hours invested: 480 hours
- Skills demonstrated: React, Node.js, Design, Python, etc.
- Impact total: "Helped 50+ clients, 100k+ users"
- Most common skill category
- Project timeline (visual history of work)

### 4. Public Portfolio Page
- Auto-generated shareable portfolio URL: myportfolio.genesistools.com/username
- Professional landing page with:
  - Intro/bio section
  - Featured projects (user selects 3-5 best)
  - Full gallery grid
  - About section
  - Stats/metrics
  - Skills section (bars showing proficiency)
  - Contact/social links
  - Download resume button (optional)
- Beautiful, mobile-responsive design
- No coding required

### 5. Work Timeline
- Chronological view of all completed projects
- Shows project names, dates, and brief descriptions
- Visual timeline with project cards
- Grouped by year or quarter
- Shows evolution of skills over time

### 6. Work-in-Progress (WIP) Tracking
- Separate section for active projects
- Shows progress toward completion
- Can be hidden from public portfolio
- Track time spent on current projects
- Estimate completion date

### 7. Skills Profile
- Visual skill matrix showing:
  - Skill name
  - Proficiency level (beginner/intermediate/advanced/expert)
  - Times used (how many projects used this skill)
  - Last used date
- Skills ranked by frequency and recent use
- Endorsed by others (if part of social network)

## Data Model

```typescript
interface PortfolioProject {
  id: string
  userId: string
  title: string
  description?: string
  category: ProjectCategory // "design", "code", "writing", "music", "video", "photography", "other"
  images: string[] // Array of image URLs
  coverImage: string // Primary image
  url?: string // Link to live project or demo
  repositoryUrl?: string // GitHub or similar
  startDate: DateTime
  endDate: DateTime
  hoursSpent?: number
  technologies: string[] // ["React", "Node.js", "Figma"]
  skills: string[] // Skills demonstrated
  impact?: {
    description: string // "Helped 10 clients"
    metric?: string // "10 clients", "50k users", "100k downloads"
  }
  status: "completed" | "wip" | "archived"
  isFeatured: boolean // Shown on public portfolio
  incomeGenerated?: number // For freelancers
  collaborators?: string[] // Other userIds
  isPublic: boolean // Visible on public portfolio
  createdAt: DateTime
  updatedAt: DateTime
}

type ProjectCategory = "design" | "code" | "writing" | "music" | "video" | "photography" | "other"

interface PortfolioSkill {
  id: string
  userId: string
  skillName: string
  proficiencyLevel: "beginner" | "intermediate" | "advanced" | "expert"
  timesUsed: number // In how many projects
  lastUsedDate: DateTime
  endorsements?: number // From network
  createdAt: DateTime
}

interface PublicPortfolioProfile {
  userId: string
  username: string
  bio?: string
  avatar?: string
  socialLinks?: {
    twitter?: string
    linkedin?: string
    github?: string
    website?: string
  }
  featuredProjects: string[] // Array of projectIds
  skills: PortfolioSkill[]
  statistics: {
    totalProjects: number
    totalHours: number
    totalIncomeGenerated?: number
    dateJoined: DateTime
  }
}

interface ResumeData {
  userId: string
  summary?: string
  experience?: Array<{
    company: string
    position: string
    startDate: DateTime
    endDate?: DateTime
    description: string
  }>
  education?: Array<{
    school: string
    degree: string
    field: string
    graduationDate: DateTime
  }>
  projects: string[] // References projectIds
  skills: string[]
}
```

## UI Components

### Add Project Form
- Multi-step form or single scrolling form
- Step 1: Title, description, category
- Step 2: Images and gallery upload
- Step 3: Details (date, URL, technologies)
- Step 4: Impact and skills
- Preview updates as you fill form
- Save as draft or publish immediately

### Portfolio Gallery Page
- Top navigation with filter tabs:
  - "All Projects", "Design", "Development", "Writing", etc.
- Search bar for keyword search
- Skill filter chips (click to show projects using skill)
- Grid of project thumbnails:
  - Thumbnail image
  - Project title
  - Technologies/skills used
  - Date or completion status
  - Click to view full details
- Detailed project view modal/page:
  - Large gallery of images
  - Title, description, dates
  - Technologies and skills
  - Impact metrics
  - Links to live project/demo
  - Related projects suggestions

### Portfolio Statistics Widget
- Dashboard home shows portfolio health
- "Portfolio: 24 projects | 480 hours | React, Python, Design..."
- Growth indicator: "+3 projects this quarter"
- Link to expand full portfolio

### Portfolio Statistics Dashboard
- Header cards:
  - Total projects (24)
  - Total hours (480)
  - Average project duration (20 days)
  - Total income (if freelance)
- Skills matrix:
  - Bar chart showing skill frequency
  - "React: 8 projects, Figma: 5 projects"
- Project timeline:
  - Visual timeline of all work chronologically
  - Grouped by year
- Project breakdown:
  - Pie chart by category
  - Bar chart by quarter/year showing project count

### Skills Profile Section
- Table showing skills with:
  - Skill name
  - Proficiency level (colored bars)
  - Number of projects using skill
  - Last used date
  - Trending indicator (↑ if recently active)
- Add new skill button
- Endorse others' skills (if social network)

### Public Portfolio Page
- Beautiful, auto-designed landing page
- Customizable but no-code
- Mobile-responsive
- Includes:
  - Hero section with name/title/bio
  - Featured projects section (3-5 highlighted)
  - Full gallery grid
  - Skills section with visual representation
  - Stats: "24 projects | 480 hours | 50+ clients"
  - Contact/social links
  - About section
  - Download resume option

### Work-in-Progress (WIP) Section
- Separate area for active projects
- Shows:
  - Project name
  - Estimated completion date
  - Hours logged so far
  - Progress bar (if estimated hours available)
  - Hidden from public portfolio by default
- Quick time-logging button

### Timeline View
- Chronological list of all projects
- Grouped by year or quarter
- Each project shows:
  - Title and brief description
  - Date range
  - Status (completed/wip)
  - Technologies/skills
  - Small thumbnail
- Can be filtered by time period
- Shows work evolution

## Integration Points

**Activity Log:**
- Completed projects appear as major milestones in timeline
- "Shipped project: E-commerce redesign"

**Freelance Tracking Integration:**
- Project shows income earned: "$2,000 for this project"
- Portfolio total: "$45,000 total earned"
- Client name linked (if making freelance feature)

**Skill Leveling System:**
- Skills in portfolio feed into skill levels
- "React: 8 projects → Advanced level"
- Proficiency levels updated based on project frequency

**Accountability Network:**
- Share project completion as milestone achievement
- Partner sees: "They just shipped a new project!"

**Social Network (Future):**
- Portfolio can be shared publicly
- Other users can endorse your skills
- Collaboration connections through portfolio viewing

## Success Criteria

- Project creation: <5 minutes including images
- Portfolio page looks professional without design work
- Portfolio stats accurately reflect project data
- Public portfolio link shareable and mobile-friendly
- Search and filtering work intuitively
- Portfolio impacts job prospects or freelance opportunities

## Technical Considerations

- Image upload and optimization
- Portfolio page generation (template system)
- Statistics calculations (hours, project count, income)
- Timeline visualization
- Public URL generation and custom domains (future)
- Responsive design for all screen sizes
- SEO optimization for public portfolio pages

## Error Handling

- Missing images: provide placeholder
- Incomplete projects: allow WIP status
- Date validation: end date must be after start date
- Image size limits: compress or reject oversized files
- URL validation: check link is accessible
- Character limits: descriptions, skills, etc.

## Privacy Considerations

- Portfolio visibility toggle: public/private
- Can hide specific projects from public view
- Income data only visible to user, not public
- WIP projects hidden from public by default
- Collaborators only visible if they've given permission
- Can opt out of being findable/endorsable

## Portfolio Customization (Future)

- Theme selection (color schemes)
- Custom domain support
- Custom sections (testimonials, awards, etc.)
- Embedded media (videos, sound clips)
- Blog/articles section
- Case study templates

## Related Features

- Skill Leveling System: tracks skills from portfolio
- Freelance Tracking: shows income per project
- Creative Metrics: complements for creative output
- Accountability Network: share project completions
- Activity Log: major milestones appear here

## Open Questions

1. Should we support video embedding (demo videos, tutorials)?
2. Should collaborators be able to edit shared projects?
3. Should we offer portfolio templates vs. completely custom?
4. Should we integrate with GitHub to auto-populate code projects?
5. Should testimonials/recommendations be supported early?
