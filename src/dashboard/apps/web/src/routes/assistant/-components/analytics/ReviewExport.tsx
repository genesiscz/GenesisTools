import { useState } from 'react'
import { Share2, Copy, Check, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import type { WeeklyReview, Streak } from '@/lib/assistant/types'

interface ReviewExportProps {
  review: WeeklyReview | null
  streak: Streak | null
  comparison: {
    tasksChange: number
    tasksChangePercent: number
    direction: 'up' | 'down' | 'same'
  } | null
  formatWeekRange: (review: WeeklyReview) => string
  disabled?: boolean
}

/**
 * Export button with dropdown for sharing weekly review
 */
export function ReviewExport({
  review,
  streak,
  comparison,
  formatWeekRange,
  disabled,
}: ReviewExportProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopyToClipboard() {
    if (!review) return

    const summary = generateSummaryText(review, streak, comparison, formatWeekRange)

    try {
      await navigator.clipboard.writeText(summary)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = summary
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  function handleDownloadMarkdown() {
    if (!review) return

    const markdown = generateMarkdownReport(review, streak, comparison, formatWeekRange)
    const blob = new Blob([markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = `weekly-review-${formatWeekRange(review).replace(/\s/g, '-')}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={disabled || !review}
        >
          <Share2 className="h-4 w-4" />
          <span className="hidden sm:inline">Export</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={handleCopyToClipboard}>
          {copied ? (
            <>
              <Check className="h-4 w-4 mr-2 text-emerald-400" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="h-4 w-4 mr-2" />
              Copy Summary
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleDownloadMarkdown}>
          <Download className="h-4 w-4 mr-2" />
          Download Report
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Generate a plain text summary for clipboard
 */
function generateSummaryText(
  review: WeeklyReview,
  streak: Streak | null,
  comparison: {
    tasksChange: number
    tasksChangePercent: number
    direction: 'up' | 'down' | 'same'
  } | null,
  formatWeekRange: (review: WeeklyReview) => string
): string {
  const lines: string[] = []

  lines.push(`Weekly Review: ${formatWeekRange(review)}`)
  lines.push('='.repeat(40))
  lines.push('')

  // Summary stats
  lines.push(`Tasks Completed: ${review.tasksCompleted}`)
  if (comparison) {
    const sign = comparison.direction === 'up' ? '+' : ''
    lines.push(`  vs Last Week: ${sign}${comparison.tasksChangePercent}%`)
  }

  const focusHours = Math.round(review.totalMinutes / 60 * 10) / 10
  lines.push(`Focus Time: ${focusHours} hours`)

  if (streak) {
    lines.push(`Current Streak: ${streak.currentStreakDays} days`)
  }

  lines.push('')

  // Deadline performance
  if (review.deadlinesTotal > 0) {
    const hitRate = Math.round((review.deadlinesHit / review.deadlinesTotal) * 100)
    lines.push(`Deadline Performance: ${hitRate}% on time (${review.deadlinesHit}/${review.deadlinesTotal})`)
  }

  // Peak focus time
  if (review.peakFocusTime) {
    lines.push(`Peak Focus Time: ${review.peakFocusTime}`)
  }

  lines.push('')

  // Badges
  if (review.badgesEarned.length > 0) {
    lines.push(`Badges Earned: ${review.badgesEarned.length}`)
  }

  // Insights
  if (review.insights.length > 0) {
    lines.push('')
    lines.push('Insights:')
    review.insights.forEach((insight) => {
      lines.push(`  - ${insight}`)
    })
  }

  return lines.join('\n')
}

/**
 * Generate a markdown report for download
 */
function generateMarkdownReport(
  review: WeeklyReview,
  streak: Streak | null,
  comparison: {
    tasksChange: number
    tasksChangePercent: number
    direction: 'up' | 'down' | 'same'
  } | null,
  formatWeekRange: (review: WeeklyReview) => string
): string {
  const lines: string[] = []

  lines.push(`# Weekly Review: ${formatWeekRange(review)}`)
  lines.push('')
  lines.push(`Generated: ${new Date().toLocaleDateString()}`)
  lines.push('')

  // Summary table
  lines.push('## Summary')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|--------|-------|')
  lines.push(`| Tasks Completed | ${review.tasksCompleted} |`)

  if (comparison) {
    const sign = comparison.direction === 'up' ? '+' : ''
    const emoji = comparison.direction === 'up' ? ' :chart_with_upwards_trend:' : comparison.direction === 'down' ? ' :chart_with_downwards_trend:' : ''
    lines.push(`| vs Last Week | ${sign}${comparison.tasksChangePercent}%${emoji} |`)
  }

  const focusHours = Math.round(review.totalMinutes / 60 * 10) / 10
  const deepFocusPercent = review.totalMinutes > 0
    ? Math.round((review.deepFocusMinutes / review.totalMinutes) * 100)
    : 0
  lines.push(`| Focus Time | ${focusHours}h (${deepFocusPercent}% deep work) |`)

  if (streak) {
    lines.push(`| Current Streak | ${streak.currentStreakDays} days |`)
    lines.push(`| Longest Streak | ${streak.longestStreakDays} days |`)
  }

  if (review.deadlinesTotal > 0) {
    const hitRate = Math.round((review.deadlinesHit / review.deadlinesTotal) * 100)
    lines.push(`| Deadline Performance | ${hitRate}% on time |`)
  }

  lines.push('')

  // Focus patterns
  lines.push('## Focus Patterns')
  lines.push('')
  if (review.peakFocusTime) {
    lines.push(`- **Peak Focus:** ${review.peakFocusTime}`)
  }
  if (review.lowEnergyTime) {
    lines.push(`- **Low Energy:** ${review.lowEnergyTime}`)
  }
  lines.push('')

  // Badges
  if (review.badgesEarned.length > 0) {
    lines.push('## Badges Earned')
    lines.push('')
    review.badgesEarned.forEach((badge) => {
      lines.push(`- ${badge}`)
    })
    lines.push('')
  }

  // Insights
  if (review.insights.length > 0) {
    lines.push('## Insights')
    lines.push('')
    review.insights.forEach((insight) => {
      lines.push(`- ${insight}`)
    })
    lines.push('')
  }

  // Recommendations
  if (review.recommendations.length > 0) {
    lines.push('## Recommendations')
    lines.push('')
    review.recommendations.forEach((rec) => {
      lines.push(`- ${rec}`)
    })
    lines.push('')
  }

  lines.push('---')
  lines.push('*Generated by Personal AI Assistant*')

  return lines.join('\n')
}
