import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { BarChart3, Clock, Loader2 } from 'lucide-react'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { DashboardLayout } from '@/components/dashboard'
import {
  FeatureCard,
  FeatureCardHeader,
  FeatureCardContent,
} from '@/components/ui/feature-card'
import { useTaskStore } from '@/lib/assistant/hooks'
import { useBadgeProgress } from '@/lib/assistant/hooks/useBadgeProgress'
import type { Badge } from '@/lib/assistant/types'
import {
  BadgeShowcase,
  BadgeProgress,
  NextBadgePreview,
  BadgeUnlockAnimation,
  useBadgeUnlock,
} from './-components/badges'

export const Route = createFileRoute('/assistant/analytics')({
  component: AnalyticsPage,
})

function AnalyticsPage() {
  const { user, loading: authLoading } = useAuth()
  const userId = user?.id ?? null

  const { badges, loading: tasksLoading, initialized } = useTaskStore(userId)
  const badgeProgressHook = useBadgeProgress(userId)

  // Badge unlock animation state
  const badgeUnlock = useBadgeUnlock()

  // Handle badge click to show detail
  const [selectedBadge, setSelectedBadge] = useState<Badge | null>(null)

  function handleBadgeClick(badge: Badge) {
    setSelectedBadge(badge)
    badgeUnlock.showUnlock(badge)
  }

  // Loading state
  if (authLoading || (!initialized && tasksLoading)) {
    return (
      <DashboardLayout title="Analytics" description="Productivity insights and patterns">
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="h-8 w-8 text-purple-400 animate-spin" />
            <span className="text-muted-foreground text-sm font-mono">Loading analytics...</span>
          </div>
        </div>
      </DashboardLayout>
    )
  }

  // Get next achievable badge
  const nextBadge = badgeProgressHook.getNextAchievableBadge()

  return (
    <DashboardLayout
      title="Analytics"
      description="Productivity insights and patterns"
    >
      <div className="space-y-8 max-w-6xl mx-auto">
        {/* Badges Section */}
        <section className="space-y-6">
          {/* Next badge preview + earned badges row */}
          <div className="grid gap-6 md:grid-cols-[300px_1fr]">
            {/* Next badge preview */}
            {nextBadge && (
              <div className="md:row-span-2">
                <NextBadgePreview progress={nextBadge} />
              </div>
            )}

            {/* Earned badges showcase */}
            <FeatureCard color="amber" className="p-6">
              <BadgeShowcase
                badges={badges}
                loading={badgeProgressHook.loading}
                onBadgeClick={handleBadgeClick}
              />
            </FeatureCard>
          </div>

          {/* In-progress badges */}
          <FeatureCard color="cyan" className="p-6">
            <BadgeProgress
              progressList={badgeProgressHook.progress}
              loading={badgeProgressHook.loading}
              maxItems={6}
              minPercent={5}
            />
          </FeatureCard>
        </section>

        {/* Coming Soon Section */}
        <section>
          <FeatureCard color="purple" className="max-w-md mx-auto">
            <FeatureCardHeader className="text-center">
              <div className="w-20 h-20 mx-auto rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center mb-4">
                <BarChart3 className="h-10 w-10 text-purple-400" />
              </div>

              <h2 className="text-2xl font-bold mb-2">More Analytics Coming</h2>
              <p className="text-muted-foreground">
                Additional productivity insights are on the way.
              </p>
            </FeatureCardHeader>

            <FeatureCardContent>
              <div className="flex items-center justify-center gap-2 py-4 px-6 rounded-lg bg-purple-500/10 border border-purple-500/20">
                <Clock className="h-5 w-5 text-purple-400" />
                <span className="font-semibold text-purple-300">Coming Soon</span>
              </div>

              <div className="mt-6 space-y-3 text-sm text-muted-foreground">
                <p className="flex items-start gap-2">
                  <span className="text-purple-400">-</span>
                  Weekly review dashboard
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-purple-400">-</span>
                  Task completion trends
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-purple-400">-</span>
                  Focus time heatmap
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-purple-400">-</span>
                  Distraction pattern detection
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-purple-400">-</span>
                  AI-generated insights
                </p>
              </div>
            </FeatureCardContent>
          </FeatureCard>
        </section>
      </div>

      {/* Badge unlock animation modal */}
      <BadgeUnlockAnimation
        badge={badgeUnlock.unlockedBadge}
        open={badgeUnlock.isOpen}
        onClose={badgeUnlock.closeUnlock}
      />
    </DashboardLayout>
  )
}
