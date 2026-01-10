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
} from 'lucide-react'
import { useAuth } from '@workos-inc/authkit-react'
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

const toolsNavItems = [
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
    <Sidebar className="border-r border-amber-500/10">
      <SidebarHeader className="border-b border-amber-500/10 p-4">
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
          <SidebarGroupLabel className="text-amber-500/60 text-[10px] tracking-widest">
            MAIN
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    className="data-[active=true]:bg-amber-500/10 data-[active=true]:text-amber-500 data-[active=true]:border-l-2 data-[active=true]:border-amber-500 hover:bg-amber-500/5"
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
          <SidebarGroupLabel className="text-cyan-500/60 text-[10px] tracking-widest">
            TOOLS
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {toolsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    className="data-[active=true]:bg-cyan-500/10 data-[active=true]:text-cyan-400 data-[active=true]:border-l-2 data-[active=true]:border-cyan-500 hover:bg-cyan-500/5"
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
          <SidebarGroupLabel className="text-muted-foreground/60 text-[10px] tracking-widest">
            SYSTEM
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {settingsNavItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    className="data-[active=true]:bg-white/5 data-[active=true]:text-white hover:bg-white/5"
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

      <SidebarFooter className="border-t border-amber-500/10 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="h-12 hover:bg-amber-500/5">
                  <Avatar className="h-7 w-7 border border-amber-500/30">
                    <AvatarImage src={user?.profilePictureUrl ?? undefined} />
                    <AvatarFallback className="bg-amber-500/10 text-amber-500 text-xs">
                      {userInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col items-start text-xs">
                    <span className="font-medium">
                      {user?.firstName ?? 'User'}
                    </span>
                    <span className="text-muted-foreground text-[10px] truncate max-w-[120px]">
                      {user?.email}
                    </span>
                  </div>
                  <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                className="w-56 bg-[#0a0a14] border-amber-500/20"
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
