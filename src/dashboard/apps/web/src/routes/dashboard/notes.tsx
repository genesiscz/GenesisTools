import { createFileRoute } from '@tanstack/react-router'
import { StickyNote, Bell, Hash, Search, FolderOpen } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/dashboard/notes')({
  component: QuickNotesPage,
})

function QuickNotesPage() {
  return (
    <DashboardLayout title="Quick Notes" description="Capture thoughts instantly with markdown support and tagging">
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="relative overflow-hidden border-emerald-500/20 bg-[#0a0a14]/80 backdrop-blur-sm max-w-lg w-full">
          {/* Tech corner decorations */}
          <div className="absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 border-emerald-500/30 rounded-tl" />
          <div className="absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 border-emerald-500/30 rounded-tr" />
          <div className="absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 border-emerald-500/30 rounded-bl" />
          <div className="absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 border-emerald-500/30 rounded-br" />

          {/* Glow effect */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl" />

          <CardHeader className="text-center relative">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
                  <StickyNote className="h-12 w-12 text-emerald-400" />
                </div>
                <div className="absolute -bottom-1 -right-1 rotate-12">
                  <div className="h-4 w-3 bg-emerald-500/20 border border-emerald-500/30 rounded-sm" />
                </div>
              </div>
            </div>

            <Badge variant="outline" className="mx-auto mb-3 bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
              Coming Soon
            </Badge>

            <CardTitle className="text-2xl">Quick Notes</CardTitle>
            <CardDescription className="text-sm max-w-sm mx-auto">
              Lightning-fast note-taking with full markdown support. Tag, search, and organize your thoughts effortlessly.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6 relative">
            {/* Feature preview */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                <Hash className="h-5 w-5 text-emerald-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Smart Tagging</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                <Search className="h-5 w-5 text-emerald-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Full-Text Search</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
                <FolderOpen className="h-5 w-5 text-emerald-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Smart Folders</span>
              </div>
            </div>

            <div className="flex flex-col items-center gap-3">
              <Button className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 hover:text-emerald-300">
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
