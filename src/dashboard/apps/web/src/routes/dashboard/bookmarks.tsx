import { createFileRoute } from '@tanstack/react-router'
import { Bookmark, Bell, Sparkles, Globe, FolderTree } from 'lucide-react'
import { DashboardLayout } from '@/components/dashboard'
import { FeatureCard, FeatureCardHeader, FeatureCardTitle, FeatureCardDescription, FeatureCardContent } from '@/components/ui/feature-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export const Route = createFileRoute('/dashboard/bookmarks')({
  component: BookmarksPage,
})

function BookmarksPage() {
  return (
    <DashboardLayout title="Bookmarks" description="Save and organize links with AI-powered summaries and search">
      <div className="flex items-center justify-center min-h-[60vh]">
        <FeatureCard color="rose" className="max-w-lg w-full">
          <FeatureCardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/20">
                  <Bookmark className="h-12 w-12 text-rose-400" />
                </div>
                <div className="absolute -top-2 -left-2">
                  <div className="h-2 w-2 bg-rose-400 rounded-full animate-pulse" />
                </div>
                <div className="absolute -bottom-1 -right-2">
                  <div className="h-1.5 w-1.5 bg-rose-400/60 rounded-full animate-pulse delay-150" />
                </div>
              </div>
            </div>

            <Badge variant="outline" className="mx-auto mb-3 bg-rose-500/20 text-rose-400 border-rose-500/30 text-xs">
              Coming Soon
            </Badge>

            <FeatureCardTitle>Bookmarks</FeatureCardTitle>
            <FeatureCardDescription className="max-w-sm mx-auto">
              Never lose a link again. AI-powered bookmark manager with automatic summaries, smart categorization, and instant search.
            </FeatureCardDescription>
          </FeatureCardHeader>

          <FeatureCardContent className="space-y-6">
            {/* Feature preview */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-rose-500/5 border border-rose-500/10">
                <Sparkles className="h-5 w-5 text-rose-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">AI Summaries</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-rose-500/5 border border-rose-500/10">
                <Globe className="h-5 w-5 text-rose-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Browser Sync</span>
              </div>
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-rose-500/5 border border-rose-500/10">
                <FolderTree className="h-5 w-5 text-rose-400/60" />
                <span className="text-[10px] text-muted-foreground text-center">Smart Collections</span>
              </div>
            </div>

            <div className="flex flex-col items-center gap-3">
              <Button className="bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500/30 hover:text-rose-300">
                <Bell className="h-4 w-4 mr-2" />
                Notify Me When Available
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Be the first to know when this feature launches
              </p>
            </div>
          </FeatureCardContent>
        </FeatureCard>
      </div>
    </DashboardLayout>
  )
}
