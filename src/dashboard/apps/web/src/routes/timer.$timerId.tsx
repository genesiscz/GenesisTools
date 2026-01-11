import { createFileRoute } from '@tanstack/react-router'
import { useAuth } from '@workos/authkit-tanstack-react-start/client'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TimerCard } from './timer/components'
import '@/components/auth/cyberpunk.css'

export const Route = createFileRoute('/timer/$timerId')({
  component: TimerPopupPage,
})

/**
 * Minimal popup page for a single timer
 * Opens in a new window without sidebar/header
 */
function TimerPopupPage() {
  const { timerId } = Route.useParams()
  const { user, loading: authLoading } = useAuth()
  const userId = user?.id ?? null

  // Loading state
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#030308] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 text-amber-500 animate-spin" />
          <span className="text-gray-500 text-sm font-mono">Loading timer...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#030308] relative overflow-hidden">
      {/* Background effects */}
      <div className="fixed inset-0 cyber-grid opacity-30 pointer-events-none" />
      <div className="fixed inset-0 scan-lines opacity-20 pointer-events-none" />

      {/* Ambient glow */}
      <div className="fixed top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Content - centered timer card */}
      <div className="relative z-10 min-h-screen flex items-center justify-center p-4">
        <div className={cn('w-full max-w-md', 'animate-fade-in-up')}>
          <TimerCard
            timerId={timerId}
            userId={userId}
            className="shadow-2xl"
          />

          {/* Window controls hint */}
          <p className="text-center text-gray-600 text-xs mt-4 font-mono">
            Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-gray-400">Esc</kbd> or close window to exit
          </p>
        </div>
      </div>
    </div>
  )
}
