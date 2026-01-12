import { SidebarProvider, SidebarTrigger, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { Separator } from '@/components/ui/separator'
import { useSettings } from '@/lib/hooks/useSettings'

interface DashboardLayoutProps {
  children: React.ReactNode
  title?: string
  description?: string
}

export function DashboardLayout({ children, title, description }: DashboardLayoutProps) {
  const { settings } = useSettings()

  return (
    <SidebarProvider>
      {/* Background effects - controlled by settings */}
      {settings.gridBackground && (
        <div className="fixed inset-0 cyber-grid opacity-40 pointer-events-none" />
      )}
      {settings.scanLinesEffect && (
        <div className="fixed inset-0 scan-lines opacity-30 pointer-events-none" />
      )}

      <AppSidebar />
      <SidebarInset className="bg-transparent">
        {/* Header */}
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-amber-500/10 bg-[#030308]/70 backdrop-blur-xl px-4">
          <SidebarTrigger className="size-9 p-2 text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 transition-colors rounded-lg" />
          <Separator orientation="vertical" className="h-4 bg-amber-500/20" />
          {title && (
            <div className="flex flex-col">
              <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
              {description && (
                <p className="text-[10px] text-muted-foreground">{description}</p>
              )}
            </div>
          )}

          {/* Status indicator */}
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="uppercase tracking-widest">System Online</span>
            </div>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 p-6">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
