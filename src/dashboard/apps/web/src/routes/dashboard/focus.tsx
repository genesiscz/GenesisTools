import { createFileRoute } from '@tanstack/react-router'
import { Target, Bell, Timer, Shield, BarChart3 } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/dashboard/focus')({
  component: FocusModePage,
})

function FocusModePage() {
  return (
    <DashboardLayout title="Focus Mode" description="Deep work sessions with Pomodoro technique and distraction blocking">
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="relative overflow-hidden border-amber-500/20 bg-[#0a0a14]/80 backdrop-blur-sm max-w-lg w-full">
          {/* Tech corner decorations */}
          <div className="absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 border-amber-500/30 rounded-tl" />
          <div className="absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 border-amber-500/30 rounded-tr" />
          <div className="absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 border-amber-500/30 rounded-bl" />
          <div className="absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 border-amber-500/30 rounded-br" />

          {/* Glow effect */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl" />

          <CardHeader className="text-center relative">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20">
                  <Target className="h-12 w-12 text-amber-400" />
                </div>
                <div className="absolute -top-1 -right-1 h-3 w-3 bg-amber-400 rounded-full animate-ping" />
                <div className="absolute -top-1 -right-1 h-3 w-3 bg-amber-400 rounded-full" />
              </div>
            </div>

            <Badge variant="outline" className="mx-auto mb-3 bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs">
              Coming Soon
            </Badge>

            <CardTitle className="text-2xl">Focus Mode</CardTitle>
            <CardDescription className="text-sm max-w-sm mx-auto">
              Achieve deep work with intelligent focus sessions. Combines Pomodoro technique with distraction blocking for maximum productivity.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6 relative">
            {/* Feature preview */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                <Timer className="h-5 w-5 text-amber-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Pomodoro Timer</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                <Shield className="h-5 w-5 text-amber-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Block Distractions</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                <BarChart3 className="h-5 w-5 text-amber-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Focus Analytics</span>
              </div>
            </div>

            <div className="flex flex-col items-center gap-3">
              <Button className="bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 hover:text-amber-300">
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
