import { memo, useState } from 'react'
import { Clock, Plus, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CountdownPickerProps {
  onSelect: (durationMs: number) => void
  className?: string
}

const PRESETS = [
  { label: '5m', ms: 5 * 60 * 1000 },
  { label: '10m', ms: 10 * 60 * 1000 },
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '25m', ms: 25 * 60 * 1000 },
  { label: '30m', ms: 30 * 60 * 1000 },
  { label: '1h', ms: 60 * 60 * 1000 },
]

/**
 * Countdown duration picker with presets and custom input
 */
export const CountdownPicker = memo(function CountdownPicker({
  onSelect,
  className,
}: CountdownPickerProps) {
  const [customMinutes, setCustomMinutes] = useState(10)

  const incrementMinutes = () => setCustomMinutes((m) => Math.min(m + 5, 180))
  const decrementMinutes = () => setCustomMinutes((m) => Math.max(m - 5, 1))

  const handleCustomSelect = () => {
    onSelect(customMinutes * 60 * 1000)
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 text-sm text-amber-400/80">
        <Clock className="h-4 w-4" />
        <span className="font-medium">Set Duration</span>
      </div>

      {/* Preset buttons */}
      <div className="grid grid-cols-3 gap-2">
        {PRESETS.map(({ label, ms }) => (
          <button
            key={label}
            onClick={() => onSelect(ms)}
            className={cn(
              'px-3 py-2 rounded-lg',
              'text-sm font-mono font-medium',
              'bg-amber-500/10 text-amber-400',
              'border border-amber-500/20',
              'hover:bg-amber-500/20 hover:border-amber-500/40',
              'transition-all duration-200'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Custom duration */}
      <div className="flex items-center gap-2 pt-2 border-t border-gray-800">
        <span className="text-xs text-gray-500">Custom:</span>
        <div className="flex items-center gap-1">
          <button
            onClick={decrementMinutes}
            className="p-1 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          >
            <Minus className="h-3 w-3" />
          </button>
          <span className="w-12 text-center font-mono text-amber-400">
            {customMinutes}m
          </span>
          <button
            onClick={incrementMinutes}
            className="p-1 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        <button
          onClick={handleCustomSelect}
          className={cn(
            'ml-auto px-3 py-1 rounded-md',
            'text-xs font-medium',
            'bg-amber-500/20 text-amber-400',
            'hover:bg-amber-500/30',
            'transition-colors'
          )}
        >
          Set
        </button>
      </div>
    </div>
  )
})
