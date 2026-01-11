import { memo } from 'react'
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
 * Timer type selector with segmented control styling
 */
export const TimerTypeSelector = memo(function TimerTypeSelector({
  type,
  onChange,
  disabled,
  className,
}: TimerTypeSelectorProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 p-1',
        'rounded-xl bg-black/40 border border-gray-800',
        disabled && 'opacity-50 pointer-events-none',
        className
      )}
    >
      {TIMER_TYPES.map(({ type: timerType, label, icon: Icon, color }) => {
        const isSelected = type === timerType

        return (
          <button
            key={timerType}
            onClick={() => onChange(timerType)}
            disabled={disabled}
            className={cn(
              'group relative flex items-center gap-2 px-4 py-2 rounded-lg',
              'text-sm font-medium transition-all duration-300',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
              isSelected
                ? [
                    color === 'cyan' && [
                      'bg-cyan-500/20 text-cyan-400',
                      'border border-cyan-500/40',
                      'shadow-[0_0_15px_rgba(0,240,255,0.2)]',
                      'focus-visible:ring-cyan-500',
                    ],
                    color === 'amber' && [
                      'bg-amber-500/20 text-amber-400',
                      'border border-amber-500/40',
                      'shadow-[0_0_15px_rgba(255,149,0,0.2)]',
                      'focus-visible:ring-amber-500',
                    ],
                    color === 'emerald' && [
                      'bg-emerald-500/20 text-emerald-400',
                      'border border-emerald-500/40',
                      'shadow-[0_0_15px_rgba(52,211,153,0.2)]',
                      'focus-visible:ring-emerald-500',
                    ],
                  ]
                : [
                    'text-gray-500 hover:text-gray-300',
                    'border border-transparent',
                    'hover:bg-gray-800/50',
                  ]
            )}
          >
            <Icon
              className={cn(
                'h-4 w-4 transition-transform',
                isSelected && 'scale-110'
              )}
            />
            <span className="hidden sm:inline">{label}</span>
          </button>
        )
      })}
    </div>
  )
})
