# UI Components

> shadcn/ui + custom dashboard components

## Component Locations

| Category | Path |
|----------|------|
| shadcn/ui primitives | `src/components/ui/` |
| Dashboard layout | `src/components/dashboard/` |
| Auth forms | `src/components/auth/` |
| Feature-specific | `src/routes/[feature]/components/` |

## shadcn/ui Components

Available in `src/components/ui/`:

| Component | Radix Base | Purpose |
|-----------|------------|---------|
| `button.tsx` | Slot | Styled button with variants |
| `card.tsx` | - | Container component |
| `feature-card.tsx` | - | Cyberpunk-styled feature cards |
| `input.tsx` | - | Text input |
| `textarea.tsx` | - | Multiline input |
| `label.tsx` | Label | Form label |
| `select.tsx` | Select | Dropdown select |
| `slider.tsx` | Slider | Range input |
| `switch.tsx` | Switch | Toggle switch |
| `avatar.tsx` | Avatar | User avatar |
| `badge.tsx` | - | Status badge |
| `dropdown-menu.tsx` | DropdownMenu | Context menus |
| `sheet.tsx` | Dialog | Side panel |
| `tooltip.tsx` | Tooltip | Hover hints |
| `separator.tsx` | Separator | Visual divider |
| `scroll-area.tsx` | ScrollArea | Scrollable container |
| `skeleton.tsx` | - | Loading placeholder |
| `sidebar.tsx` | - | Sidebar navigation |

## Button Component

```tsx
import { Button } from '@/components/ui/button'

// Variants: default, destructive, outline, secondary, ghost, link
// Sizes: default, sm, lg, icon, icon-sm, icon-lg

<Button variant="outline" size="sm">Click me</Button>
<Button asChild><Link to="/page">Navigate</Link></Button>
```

## FeatureCard Component

Custom cyberpunk-styled card with colored borders:

```tsx
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardContent,
  type FeatureCardColor
} from '@/components/ui/feature-card'

// Colors: cyan, purple, amber, emerald, rose, blue, primary

<FeatureCard color="purple">
  <FeatureCardHeader>
    <h4>Title</h4>
    <p>Description</p>
  </FeatureCardHeader>
  <FeatureCardContent>
    {content}
  </FeatureCardContent>
</FeatureCard>
```

## Dashboard Layout Components

From `src/components/dashboard/`:

```tsx
import { DashboardLayout, AppSidebar } from '@/components/dashboard'

// DashboardLayout wraps pages with sidebar + header
<DashboardLayout title="Page Title" description="Subtitle">
  {children}
</DashboardLayout>
```

### DashboardLayout Props

| Prop | Type | Purpose |
|------|------|---------|
| `title` | `string` | Page title in header |
| `description` | `string` | Subtitle in header |
| `children` | `ReactNode` | Page content |

### AppSidebar

Navigation sidebar with:
- Logo + branding
- Main nav (Dashboard, Timer)
- Tools nav (AI, Focus, Notes, etc.)
- System nav (Settings, Profile)
- User dropdown (profile, signout)

## Styling Utilities

From `src/lib/utils.ts`:

```tsx
import { cn } from '@/lib/utils'

// Merges Tailwind classes safely
<div className={cn('base-class', condition && 'conditional-class')} />
```

## Theme System

CSS variables defined in `src/styles.css`:

| Variable | Purpose |
|----------|---------|
| `--primary` | Amber (main brand color) |
| `--secondary` | Cyan (accent) |
| `--background` | Deep dark blue-black |
| `--foreground` | Text color |
| `--muted` | Subdued text/bg |
| `--destructive` | Error/danger |
| `--sidebar-*` | Sidebar-specific colors |

Custom utility classes:
- `.gradient-text` - Amber-to-cyan gradient
- `.neon-glow` - Neon text shadow
- `.cyber-border` - Gradient border
- `.animate-pulse-subtle` - Subtle pulsing
- `.animate-slide-up` - Slide in animation
