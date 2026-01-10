import { createFileRoute } from '@tanstack/react-router'
import { Brain, Bell, Sparkles, MessageSquare, Lightbulb, Zap } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/dashboard/ai')({
  component: AIAssistantPage,
})

function AIAssistantPage() {
  return (
    <DashboardLayout title="AI Assistant" description="Your personal AI companion for tasks, research, and creativity">
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="relative overflow-hidden border-purple-500/20 bg-[#0a0a14]/80 backdrop-blur-sm max-w-lg w-full">
          {/* Tech corner decorations */}
          <div className="absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 border-purple-500/30 rounded-tl" />
          <div className="absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 border-purple-500/30 rounded-tr" />
          <div className="absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 border-purple-500/30 rounded-bl" />
          <div className="absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 border-purple-500/30 rounded-br" />

          {/* Glow effect */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-purple-500/10 rounded-full blur-3xl" />

          <CardHeader className="text-center relative">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="p-4 rounded-2xl bg-purple-500/10 border border-purple-500/20">
                  <Brain className="h-12 w-12 text-purple-400" />
                </div>
                <div className="absolute -top-1 -right-1">
                  <Sparkles className="h-4 w-4 text-purple-400 animate-pulse" />
                </div>
              </div>
            </div>

            <Badge variant="outline" className="mx-auto mb-3 bg-purple-500/20 text-purple-400 border-purple-500/30 text-xs">
              Coming Soon
            </Badge>

            <CardTitle className="text-2xl">AI Assistant</CardTitle>
            <CardDescription className="text-sm max-w-sm mx-auto">
              Your personal AI companion powered by advanced language models. Get help with research, writing, coding, and creative tasks.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6 relative">
            {/* Feature preview */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-purple-500/5 border border-purple-500/10">
                <MessageSquare className="h-5 w-5 text-purple-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Chat Interface</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-purple-500/5 border border-purple-500/10">
                <Lightbulb className="h-5 w-5 text-purple-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Smart Suggestions</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-purple-500/5 border border-purple-500/10">
                <Zap className="h-5 w-5 text-purple-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Quick Actions</span>
              </div>
            </div>

            <div className="flex flex-col items-center gap-3">
              <Button className="bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 hover:text-purple-300">
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
