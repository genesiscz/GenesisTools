import { memo, useCallback } from 'react'
import { Timer, Hourglass, Coffee } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TimerType } from '@dashboard/shared'

interface TimerTypeSelectorProps {
  type: TimerType
  onChange: (type: TimerType) => void
  disabled?: boolean
  className?: string
}

const TIMER_TYPES: { type: TimerType; label: string; icon: typeof Timer; color: string }[] = [
  { type: 'stopwatch', label: 'Stopwatch', icon: Timer, color: 'cyan' },
  { type: 'countdown', label: 'Countdown', icon: Hourglass, color: 'amber' },
  { type: 'pomodoro', label: 'Pomodoro', icon: Coffee, color: 'emerald' },
]

/**
 * Timer type selector - single button that cycles through types
 */
export const TimerTypeSelector = memo(function TimerTypeSelector({
  type,
  onChange,
  disabled,
  className,
}: TimerTypeSelectorProps) {
  const currentIndex = TIMER_TYPES.findIndex((t) => t.type === type)
  const current = TIMER_TYPES[currentIndex]
  const Icon = current.icon

  const cycleType = useCallback(() => {
    const nextIndex = (currentIndex + 1) % TIMER_TYPES.length
    onChange(TIMER_TYPES[nextIndex].type)
  }, [currentIndex, onChange])

  return (
    <button
      onClick={cycleType}
      disabled={disabled}
      title={`Switch to ${TIMER_TYPES[(currentIndex + 1) % TIMER_TYPES.length].label}`}
      className={cn(
        'group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg',
        'text-xs font-medium transition-all duration-200',
        'border',
        disabled && 'opacity-50 cursor-not-allowed',
        current.color === 'cyan' && [
          'bg-cyan-500/15 text-cyan-400',
          'border-cyan-500/30',
          'hover:bg-cyan-500/25 hover:border-cyan-500/50',
        ],
        current.color === 'amber' && [
          'bg-amber-500/15 text-amber-400',
          'border-amber-500/30',
          'hover:bg-amber-500/25 hover:border-amber-500/50',
        ],
        current.color === 'emerald' && [
          'bg-emerald-500/15 text-emerald-400',
          'border-emerald-500/30',
          'hover:bg-emerald-500/25 hover:border-emerald-500/50',
        ],
        className
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{current.label}</span>
    </button>
  )
})
