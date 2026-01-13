import { useState } from 'react'
import { Calendar, RefreshCw, Loader2, BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useWeeklyReview, useStreak } from '@/lib/assistant/hooks'

import { WeekStats } from './WeekStats'
import { CompletionTrend } from './CompletionTrend'
import { DeadlinePerformance } from './DeadlinePerformance'
import { EnergyByDay } from './EnergyByDay'
import { WeeklyInsights } from './WeeklyInsights'
import { BadgesEarned } from './BadgesEarned'
import { ReviewExport } from './ReviewExport'

interface WeeklyReviewProps {
  userId: string | null
}

type WeekOption = 'current' | 'last' | '2-weeks' | '3-weeks'

/**
 * Main weekly review dashboard component
 */
export function WeeklyReview({ userId }: WeeklyReviewProps) {
  const [selectedWeek, setSelectedWeek] = useState<WeekOption>('current')

  const {
    reviews,
    currentReview,
    loading,
    generating,
    generateCurrentWeekReview,
    generateLastWeekReview,
    generateReview,
    getWeekOverWeekComparison,
    formatWeekRange,
  } = useWeeklyReview(userId)

  const { streak, loading: streakLoading } = useStreak(userId)

  // Get the review for the selected week
  const selectedReview = getSelectedReview(selectedWeek, reviews, currentReview)

  // Get comparison data
  const comparison = selectedWeek === 'current' ? getWeekOverWeekComparison() : null

  // Handle generating review
  async function handleGenerateReview() {
    if (!userId) return

    switch (selectedWeek) {
      case 'current':
        await generateCurrentWeekReview()
        break
      case 'last':
        await generateLastWeekReview()
        break
      default:
        // For older weeks, calculate the dates
        const weeksAgo = selectedWeek === '2-weeks' ? 2 : 3
        const now = new Date()
        const startOfThisWeek = new Date(now)
        startOfThisWeek.setDate(now.getDate() - now.getDay())
        startOfThisWeek.setHours(0, 0, 0, 0)

        const weekStart = new Date(startOfThisWeek)
        weekStart.setDate(weekStart.getDate() - (weeksAgo * 7))

        const weekEnd = new Date(weekStart)
        weekEnd.setDate(weekEnd.getDate() + 6)
        weekEnd.setHours(23, 59, 59, 999)

        await generateReview({ weekStart, weekEnd })
    }
  }

  const isLoading = loading || streakLoading

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
            <BarChart3 className="h-5 w-5 text-purple-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Weekly Review</h2>
            <p className="text-sm text-muted-foreground">
              {selectedReview
                ? formatWeekRange(selectedReview)
                : 'Generate a review to see your stats'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Week selector */}
          <Select
            value={selectedWeek}
            onValueChange={(value: WeekOption) => setSelectedWeek(value)}
          >
            <SelectTrigger className="w-[140px]">
              <Calendar className="h-4 w-4 mr-2 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">This Week</SelectItem>
              <SelectItem value="last">Last Week</SelectItem>
              <SelectItem value="2-weeks">2 Weeks Ago</SelectItem>
              <SelectItem value="3-weeks">3 Weeks Ago</SelectItem>
            </SelectContent>
          </Select>

          {/* Generate button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateReview}
            disabled={generating || !userId}
            className="gap-2"
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {selectedReview ? 'Refresh' : 'Generate'}
            </span>
          </Button>

          {/* Export button */}
          <ReviewExport
            review={selectedReview}
            streak={streak}
            comparison={comparison}
            formatWeekRange={formatWeekRange}
            disabled={!selectedReview}
          />
        </div>
      </div>

      {/* No data state */}
      {!selectedReview && !isLoading && !generating && (
        <NoReviewState onGenerate={handleGenerateReview} disabled={!userId} />
      )}

      {/* Dashboard grid */}
      {(selectedReview || isLoading || generating) && (
        <div className="space-y-6">
          {/* Summary stats */}
          <WeekStats
            review={selectedReview}
            streak={streak}
            comparison={comparison}
            loading={isLoading || generating}
          />

          {/* Charts row */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Completion trend */}
            <CompletionTrend reviews={reviews} loading={isLoading || generating} />

            {/* Charts sub-grid */}
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {/* Deadline performance */}
              <DeadlinePerformance review={selectedReview} loading={isLoading || generating} />

              {/* Energy by day */}
              <EnergyByDay review={selectedReview} loading={isLoading || generating} />
            </div>
          </div>

          {/* Bottom row */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Insights */}
            <WeeklyInsights
              review={selectedReview}
              comparison={comparison}
              loading={isLoading || generating}
            />

            {/* Badges */}
            <BadgesEarned review={selectedReview} loading={isLoading || generating} />
          </div>
        </div>
      )}
    </div>
  )
}

function getSelectedReview(
  selectedWeek: WeekOption,
  reviews: ReturnType<typeof useWeeklyReview>['reviews'],
  currentReview: ReturnType<typeof useWeeklyReview>['currentReview']
) {
  if (selectedWeek === 'current') {
    return currentReview
  }

  // Calculate the start of the selected week
  const now = new Date()
  const startOfThisWeek = new Date(now)
  startOfThisWeek.setDate(now.getDate() - now.getDay())
  startOfThisWeek.setHours(0, 0, 0, 0)

  let weeksAgo = 0
  switch (selectedWeek) {
    case 'last':
      weeksAgo = 1
      break
    case '2-weeks':
      weeksAgo = 2
      break
    case '3-weeks':
      weeksAgo = 3
      break
  }

  const targetWeekStart = new Date(startOfThisWeek)
  targetWeekStart.setDate(targetWeekStart.getDate() - (weeksAgo * 7))

  // Find matching review
  return reviews.find((r) => {
    const reviewStart = new Date(r.weekStart)
    reviewStart.setHours(0, 0, 0, 0)
    return reviewStart.getTime() === targetWeekStart.getTime()
  }) ?? null
}

function NoReviewState({
  onGenerate,
  disabled,
}: {
  onGenerate: () => void
  disabled: boolean
}) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#0a0a14]/80 backdrop-blur-sm border border-white/5">
      {/* Corner decorations */}
      <div className="absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 border-purple-500/20 rounded-tl" />
      <div className="absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 border-purple-500/20 rounded-tr" />
      <div className="absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 border-purple-500/20 rounded-bl" />
      <div className="absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 border-purple-500/20 rounded-br" />

      <div className="flex flex-col items-center justify-center py-16 px-6">
        {/* Icon */}
        <div
          className={cn(
            'relative w-24 h-24 mb-6',
            'flex items-center justify-center',
            'rounded-full',
            'bg-gradient-to-br from-purple-500/10 to-purple-500/5',
            'border border-purple-500/20'
          )}
        >
          <div className="absolute inset-0 rounded-full border border-purple-500/10 animate-pulse" />
          <BarChart3 className="h-10 w-10 text-purple-400/50" />
        </div>

        {/* Text */}
        <h3 className="text-lg font-semibold text-foreground/70 mb-2">
          No Review Generated
        </h3>
        <p className="text-muted-foreground text-center max-w-md mb-6">
          Generate a weekly review to see your productivity stats, insights, and achievements.
        </p>

        {/* CTA */}
        <Button
          onClick={onGenerate}
          disabled={disabled}
          className="gap-2 bg-purple-600 hover:bg-purple-700"
        >
          <RefreshCw className="h-4 w-4" />
          Generate Review
        </Button>
      </div>
    </div>
  )
}
