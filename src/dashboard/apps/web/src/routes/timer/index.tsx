import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { TimerCard, TimerHeader } from './components'
import { useTimerStore } from './hooks/useTimerStore'
import type { TimerInput } from '@dashboard/shared'
import '@/components/auth/cyberpunk.css'

export const Route = createFileRoute('/timer/')({
  component: TimerPage,
})

function TimerPage() {
  const { user, loading: authLoading } = useAuth()
  const userId = user?.id ?? null

  const { timers, loading, initialized, createTimer, deleteTimer } = useTimerStore(userId)

  // Count running timers
  const runningCount = useMemo(() => timers.filter((t) => t.isRunning).length, [timers])

  // Add new timer
  const handleAddTimer = useCallback(async () => {
    const input: TimerInput = {
      name: `Timer ${timers.length + 1}`,
      timerType: 'stopwatch',
      isRunning: false,
      elapsedTime: 0,
      duration: 5 * 60 * 1000, // 5 minutes default for countdown
      laps: [],
      showTotal: false,
      firstStartTime: null,
      startTime: null,
      pomodoroSessionCount: 0,
    }
    await createTimer(input)
  }, [timers.length, createTimer])

  // Delete timer
  const handleDeleteTimer = useCallback(
    async (id: string) => {
      await deleteTimer(id)
    },
    [deleteTimer]
  )

  // Pop out timer (Phase 2)
  const handlePopoutTimer = useCallback((id: string) => {
    // TODO: Implement pop-out window in Phase 2
    const width = 400
    const height = 500
    const left = window.screen.width / 2 - width / 2
    const top = window.screen.height / 2 - height / 2
    window.open(
      `/timer/${id}`,
      `timer-${id}`,
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
    )
  }, [])

  // Loading state
  if (authLoading || (!initialized && loading)) {
    return (
      <div className="min-h-screen bg-[#030308] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 text-amber-500 animate-spin" />
          <span className="text-gray-500 text-sm font-mono">Loading timers...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#030308] text-white">
      {/* Cyberpunk background effects */}
      <div className="fixed inset-0 cyber-grid opacity-20 pointer-events-none" />
      <div className="fixed inset-0 scan-lines pointer-events-none" />

      {/* Ambient gradient orbs */}
      <div className="fixed top-1/4 -left-1/4 w-1/2 h-1/2 bg-amber-500/5 rounded-full blur-[150px] pointer-events-none" />
      <div className="fixed bottom-1/4 -right-1/4 w-1/2 h-1/2 bg-cyan-500/5 rounded-full blur-[150px] pointer-events-none" />

      {/* Header */}
      <TimerHeader
        timerCount={timers.length}
        runningCount={runningCount}
        onAddTimer={handleAddTimer}
      />

      {/* Main content */}
      <main className="relative z-10 container mx-auto px-6 py-8">
        {timers.length === 0 ? (
          <EmptyState onAddTimer={handleAddTimer} />
        ) : (
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {timers.map((timer, index) => (
              <div
                key={timer.id}
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <TimerCard
                  timerId={timer.id}
                  userId={userId}
                  onDelete={handleDeleteTimer}
                  onPopout={handlePopoutTimer}
                />
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

/**
 * Empty state with call to action
 */
function EmptyState({ onAddTimer }: { onAddTimer: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6">
      {/* Decorative element */}
      <div
        className={cn(
          'relative w-32 h-32 mb-8',
          'flex items-center justify-center',
          'rounded-full',
          'bg-gradient-to-br from-amber-500/10 to-amber-600/5',
          'border border-amber-500/20',
          'animate-pulse-glow'
        )}
      >
        {/* Ripple effects */}
        <div className="absolute inset-0 rounded-full border border-amber-500/20 animate-ripple" />
        <div className="absolute inset-0 rounded-full border border-amber-500/20 animate-ripple-delayed" />
        <div className="absolute inset-0 rounded-full border border-amber-500/20 animate-ripple-delayed-2" />

        <span
          className="text-5xl font-mono font-bold text-amber-500/50"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          00:00
        </span>
      </div>

      {/* Text */}
      <h2 className="text-xl font-semibold text-gray-400 mb-2">No timers yet</h2>
      <p className="text-gray-600 text-center max-w-md mb-8">
        Create your first timer to start tracking time. Stopwatch, countdown, or pomodoro - choose
        what works for you.
      </p>

      {/* CTA Button */}
      <button
        onClick={onAddTimer}
        className={cn(
          'group relative flex items-center gap-3 px-8 py-4 rounded-xl',
          'font-semibold text-lg text-black',
          'bg-gradient-to-br from-amber-400 to-amber-500',
          'shadow-[0_0_40px_rgba(255,149,0,0.4)]',
          'transition-all duration-300',
          'hover:shadow-[0_0_60px_rgba(255,149,0,0.6)]',
          'hover:scale-[1.02] active:scale-[0.98]',
          'overflow-hidden'
        )}
      >
        {/* Shimmer effect */}
        <div
          className={cn(
            'absolute inset-0 opacity-0 group-hover:opacity-100',
            'bg-gradient-to-r from-transparent via-white/30 to-transparent',
            'translate-x-[-100%] group-hover:translate-x-[100%]',
            'transition-transform duration-700 ease-out'
          )}
        />

        <Plus className="h-6 w-6 relative z-10" />
        <span className="relative z-10">Create your first timer</span>
      </button>
    </div>
  )
}
