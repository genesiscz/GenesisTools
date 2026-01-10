import { createFileRoute } from '@tanstack/react-router'
import { CalendarDays, Bell, Sparkles, Clock, ListChecks } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/dashboard/planner')({
  component: DailyPlannerPage,
})

function DailyPlannerPage() {
  return (
    <DashboardLayout title="Daily Planner" description="AI-assisted daily planning with smart scheduling and reminders">
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="relative overflow-hidden border-blue-500/20 bg-[#0a0a14]/80 backdrop-blur-sm max-w-lg w-full">
          {/* Tech corner decorations */}
          <div className="absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 border-blue-500/30 rounded-tl" />
          <div className="absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 border-blue-500/30 rounded-tr" />
          <div className="absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 border-blue-500/30 rounded-bl" />
          <div className="absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 border-blue-500/30 rounded-br" />

          {/* Glow effect */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl" />

          <CardHeader className="text-center relative">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/20">
                  <CalendarDays className="h-12 w-12 text-blue-400" />
                </div>
                <div className="absolute top-0 right-0 translate-x-1/2 -translate-y-1/3">
                  <div className="px-1.5 py-0.5 bg-blue-500/20 border border-blue-500/30 rounded text-[8px] text-blue-400 font-mono">
                    {new Date().getDate()}
                  </div>
                </div>
              </div>
            </div>

            <Badge variant="outline" className="mx-auto mb-3 bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs">
              Coming Soon
            </Badge>

            <CardTitle className="text-2xl">Daily Planner</CardTitle>
            <CardDescription className="text-sm max-w-sm mx-auto">
              Plan your perfect day with AI assistance. Smart scheduling, time blocking, and intelligent reminders to keep you on track.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6 relative">
            {/* Feature preview */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
                <Sparkles className="h-5 w-5 text-blue-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">AI Scheduling</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
                <Clock className="h-5 w-5 text-blue-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Time Blocking</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
                <ListChecks className="h-5 w-5 text-blue-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Task Integration</span>
              </div>
            </div>

            <div className="flex flex-col items-center gap-3">
              <Button className="bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 hover:text-blue-300">
                <Bell className="h-4 w-4 mr-2" />
                Notify Me When Available
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Be the first to know when this feature launches
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
