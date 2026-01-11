import { Link, useLocation } from '@tanstack/react-router'
import {
  Timer,
  LayoutDashboard,
  Brain,
  Target,
  StickyNote,
  Bookmark,
  CalendarDays,
  Settings,
  User,
  LogOut,
  ChevronUp,
  ListTodo,
  Compass,
  ParkingCircle,
  Scale,
  MessageSquare,
  BarChart3,
} from 'lucide-react'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

const mainNavItems = [
  {
    title: 'Dashboard',
    url: '/dashboard',
    icon: LayoutDashboard,
  },
  {
    title: 'Timer',
    url: '/timer',
    icon: Timer,
  },
]

// Assistant navigation items (purple theme)
const assistantNavItems = [
  {
    title: 'Tasks',
    url: '/assistant/tasks',
    icon: ListTodo,
  },
  {
    title: "What's Next",
    url: '/assistant/next',
    icon: Compass,
  },
  {
    title: 'Context Parking',
    url: '/assistant/parking',
    icon: ParkingCircle,
  },
  {
    title: 'Decisions',
    url: '/assistant/decisions',
    icon: Scale,
  },
  {
    title: 'Communication',
    url: '/assistant/communication',
    icon: MessageSquare,
  },
  {
    title: 'Analytics',
    url: '/assistant/analytics',
    icon: BarChart3,
  },
]

// Apps navigation items (existing tools, renamed from "Tools")
const appsNavItems = [
  {
    title: 'AI Assistant',
    url: '/dashboard/ai',
    icon: Brain,
  },
  {
    title: 'Focus Mode',
    url: '/dashboard/focus',
    icon: Target,
  },
  {
    title: 'Quick Notes',
    url: '/dashboard/notes',
    icon: StickyNote,
  },
  {
    title: 'Bookmarks',
    url: '/dashboard/bookmarks',
    icon: Bookmark,
  },
  {
    title: 'Daily Planner',
    url: '/dashboard/planner',
    icon: CalendarDays,
  },
]

const settingsNavItems = [
  {
    title: 'Settings',
    url: '/settings',
    icon: Settings,
  },
  {
    title: 'Profile',
    url: '/profile',
    icon: User,
  },
]

export function AppSidebar() {
  const location = useLocation()
  const { user, signOut } = useAuth()

  const isActive = (url: string) => {
    if (url === '/dashboard') {
      return location.pathname === '/dashboard'
    }
    return location.pathname.startsWith(url)
  }

  const userInitials = user?.firstName && user?.lastName
    ? `${user.firstName[0]}${user.lastName[0]}`
    : user?.email?.[0]?.toUpperCase() ?? '?'

  return (
    <Sidebar className="border-r border-sidebar-border bg-sidebar">
      <SidebarHeader className="border-b border-sidebar-border p-4 bg-gradient-to-b from-sidebar to-sidebar/80">
        <Link to="/dashboard" className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 text-black font-bold text-sm">
            N
          </div>
          <div className="flex flex-col">
            <span className="font-semibold text-sm tracking-tight gradient-text">
              NEXUS
            </span>
            <span className="text-[10px] text-muted-foreground tracking-widest uppercase">
              Command Center
            </span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-2">
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-primary/70 text-[10px] tracking-widest uppercase font-semibold">
            Main
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    className="data-[active=true]:bg-sidebar-primary/15 data-[active=true]:text-sidebar-primary data-[active=true]:border-l-2 data-[active=true]:border-sidebar-primary hover:bg-sidebar-primary/10 hover:text-sidebar-foreground transition-colors"
                  >
                    <Link to={item.url}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Assistant group with purple theme */}
        <SidebarGroup>
          <SidebarGroupLabel className="text-purple-400/70 text-[10px] tracking-widest uppercase font-semibold">
            Assistant
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {assistantNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    className="data-[active=true]:bg-purple-500/15 data-[active=true]:text-purple-400 data-[active=true]:border-l-2 data-[active=true]:border-purple-500 hover:bg-purple-500/10 hover:text-sidebar-foreground transition-colors"
                  >
                    <Link to={item.url}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-accent/70 text-[10px] tracking-widest uppercase font-semibold">
            Apps
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {appsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    className="data-[active=true]:bg-sidebar-accent/15 data-[active=true]:text-sidebar-accent data-[active=true]:border-l-2 data-[active=true]:border-sidebar-accent hover:bg-sidebar-accent/10 hover:text-sidebar-foreground transition-colors"
                  >
                    <Link to={item.url}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/50 text-[10px] tracking-widest uppercase font-semibold">
            System
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {settingsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    className="data-[active=true]:bg-sidebar-foreground/10 data-[active=true]:text-sidebar-foreground hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground transition-colors"
                  >
                    <Link to={item.url}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2 bg-gradient-to-t from-sidebar to-sidebar/80">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="h-12 hover:bg-sidebar-accent/10 transition-colors">
                  <Avatar className="h-7 w-7 border border-sidebar-primary/30">
                    <AvatarImage src={user?.profilePictureUrl ?? undefined} />
                    <AvatarFallback className="bg-sidebar-primary/10 text-sidebar-primary text-xs font-semibold">
                      {userInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col items-start text-xs">
                    <span className="font-medium text-sidebar-foreground">
                      {user?.firstName ?? 'User'}
                    </span>
                    <span className="text-sidebar-foreground/60 text-[10px] truncate max-w-[120px]">
                      {user?.email}
                    </span>
                  </div>
                  <ChevronUp className="ml-auto h-4 w-4 text-sidebar-foreground/50" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                className="w-56 bg-card border-border/50 shadow-lg"
              >
                <DropdownMenuItem asChild>
                  <Link to="/profile" className="cursor-pointer">
                    <User className="mr-2 h-4 w-4" />
                    Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/settings" className="cursor-pointer">
                    <Settings className="mr-2 h-4 w-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-amber-500/10" />
                <DropdownMenuItem
                  onClick={() => signOut()}
                  className="text-red-400 focus:text-red-400 cursor-pointer"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
