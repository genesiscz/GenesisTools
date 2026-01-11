import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { Timer } from '@dashboard/shared'
import { useActivityLog, getTodayRange, getWeekRange, getMonthRange } from '../hooks/useActivityLog'
import { ActivityLogEntry } from './ActivityLogEntry'
import { ProductivityStats } from './ProductivityStats'
import {
  X,
  Filter,
  Calendar,
  RefreshCw,
  Trash2,
  ChevronDown,
  Activity,
  Clock,
  BarChart3,
} from 'lucide-react'

interface ActivityLogSidebarProps {
  userId: string | null
  timers: Timer[]
  isOpen: boolean
  onClose: () => void
  className?: string
}

type TimeRange = 'today' | 'week' | 'month' | 'all'
type TabView = 'timeline' | 'stats'

/**
 * Activity log sidebar with timeline, filtering, and productivity stats
 */
export function ActivityLogSidebar({
  userId,
  timers,
  isOpen,
  onClose,
  className,
}: ActivityLogSidebarProps) {
  const [activeTab, setActiveTab] = useState<TabView>('timeline')
  const [timeRange, setTimeRange] = useState<TimeRange>('today')
  const [showFilters, setShowFilters] = useState(false)
  const [selectedTimerId, setSelectedTimerId] = useState<string | null>(null)

  // Get date range based on selection
  function getDateRange(): { start: Date; end: Date } | null {
    switch (timeRange) {
      case 'today':
        return getTodayRange()
      case 'week':
        return getWeekRange()
      case 'month':
        return getMonthRange()
      default:
        return null
    }
  }

  const dateRange = getDateRange()

  const {
    entries,
    loading,
    error,
    refresh,
    clearAll,
    setFilter,
  } = useActivityLog({
    userId,
    autoRefresh: true,
    refreshInterval: 30000,
  })

  // Apply filters when they change
  function handleTimeRangeChange(range: TimeRange) {
    setTimeRange(range)
    const newRange = range === 'today' ? getTodayRange()
      : range === 'week' ? getWeekRange()
      : range === 'month' ? getMonthRange()
      : null

    setFilter({
      startDate: newRange?.start,
      endDate: newRange?.end,
    })
  }

  function handleTimerFilter(timerId: string | null) {
    setSelectedTimerId(timerId)
    setFilter({ timerId: timerId || undefined })
  }

  function handleClearAll() {
    if (window.confirm('Clear all activity log entries? This cannot be undone.')) {
      clearAll()
    }
  }

  if (!isOpen) return null

  return (
    <div
      className={cn(
        'fixed inset-y-0 right-0 z-50',
        'w-full max-w-md',
        'bg-gradient-to-bl from-gray-900 via-gray-900 to-gray-950',
        'border-l border-amber-500/20',
        'shadow-[-10px_0_30px_rgba(0,0,0,0.5)]',
        'flex flex-col',
        'animate-slide-in-right',
        className
      )}
    >
      {/* Ambient glow */}
      <div className="absolute inset-0 -z-10 opacity-30">
        <div className="absolute top-0 right-0 w-64 h-64 bg-amber-500/10 blur-3xl" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-cyan-500/10 blur-3xl" />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800/80">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-amber-500/10">
            <Activity className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-100">Activity Log</h2>
            <p className="text-xs text-gray-500">{entries.length} events recorded</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className={cn(
            'p-2 rounded-lg',
            'text-gray-500 hover:text-gray-300',
            'hover:bg-gray-800/50',
            'transition-colors duration-200'
          )}
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-1 px-4 py-3 border-b border-gray-800/50">
        <button
          onClick={() => setActiveTab('timeline')}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg',
            'text-sm font-medium transition-all duration-200',
            activeTab === 'timeline'
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
              : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/30'
          )}
        >
          <Clock className="h-4 w-4" />
          <span>Timeline</span>
        </button>
        <button
          onClick={() => setActiveTab('stats')}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg',
            'text-sm font-medium transition-all duration-200',
            activeTab === 'stats'
              ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30'
              : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/30'
          )}
        >
          <BarChart3 className="h-4 w-4" />
          <span>Stats</span>
        </button>
      </div>

      {/* Time range selector */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800/50">
        <Calendar className="h-4 w-4 text-gray-500" />
        <div className="flex-1 flex gap-1">
          {(['today', 'week', 'month', 'all'] as const).map((range) => (
            <button
              key={range}
              onClick={() => handleTimeRangeChange(range)}
              className={cn(
                'flex-1 px-2 py-1.5 rounded-md text-xs font-medium',
                'transition-all duration-200',
                timeRange === range
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/30'
              )}
            >
              {range === 'all' ? 'All' : range.charAt(0).toUpperCase() + range.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Filter bar */}
      <div className="px-4 py-2 border-b border-gray-800/50">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg',
              'text-sm transition-all duration-200',
              showFilters
                ? 'bg-gray-700/50 text-gray-300'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/30'
            )}
          >
            <Filter className="h-4 w-4" />
            <span>Filters</span>
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', showFilters && 'rotate-180')}
            />
          </button>

          <div className="flex-1" />

          <button
            onClick={refresh}
            disabled={loading}
            className={cn(
              'p-1.5 rounded-lg',
              'text-gray-500 hover:text-gray-300',
              'hover:bg-gray-800/30',
              'transition-colors duration-200',
              loading && 'animate-spin'
            )}
          >
            <RefreshCw className="h-4 w-4" />
          </button>

          <button
            onClick={handleClearAll}
            className={cn(
              'p-1.5 rounded-lg',
              'text-red-500/70 hover:text-red-400',
              'hover:bg-red-500/10',
              'transition-colors duration-200'
            )}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        {/* Expandable filter options */}
        {showFilters && (
          <div className="mt-3 p-3 rounded-lg bg-gray-800/30 border border-gray-700/50">
            <label className="block text-xs text-gray-500 mb-2">Filter by timer</label>
            <select
              value={selectedTimerId || ''}
              onChange={(e) => handleTimerFilter(e.target.value || null)}
              className={cn(
                'w-full px-3 py-2 rounded-lg',
                'bg-gray-900 border border-gray-700',
                'text-sm text-gray-300',
                'focus:outline-none focus:border-amber-500/50'
              )}
            >
              <option value="">All timers</option>
              {timers.map((timer) => (
                <option key={timer.id} value={timer.id}>
                  {timer.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'timeline' ? (
          <div className="px-4 py-4">
            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {loading && entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                <RefreshCw className="h-8 w-8 animate-spin mb-3" />
                <p className="text-sm">Loading activity...</p>
              </div>
            ) : entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                <Activity className="h-12 w-12 mb-3 opacity-30" />
                <p className="text-sm">No activity recorded yet</p>
                <p className="text-xs mt-1 opacity-70">
                  Start a timer to see events here
                </p>
              </div>
            ) : (
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-6 top-0 bottom-0 w-px bg-gradient-to-b from-gray-700/50 via-gray-700/30 to-transparent" />

                {/* Entries */}
                <div className="space-y-0">
                  {entries.map((entry, index) => (
                    <ActivityLogEntry
                      key={entry.id}
                      entry={entry}
                      className={cn(
                        index === 0 && 'pt-0',
                        index === entries.length - 1 && 'pb-0'
                      )}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <ProductivityStats
            userId={userId}
            startDate={dateRange?.start}
            endDate={dateRange?.end}
            timeRangeLabel={timeRange === 'all' ? 'All time' : `This ${timeRange}`}
            timerId={selectedTimerId || undefined}
            timerNames={Object.fromEntries(timers.map(t => [t.id, t.name]))}
          />
        )}
      </div>

      {/* Scanline effect overlay */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0',
          'bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(0,0,0,0.03)_2px,rgba(0,0,0,0.03)_4px)]'
        )}
      />
    </div>
  )
}
