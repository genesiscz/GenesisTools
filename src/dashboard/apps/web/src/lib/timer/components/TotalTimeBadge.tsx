import { memo, useMemo } from 'react'
import { Clock, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TotalTimeBadgeProps {
  totalTimeMs: number
  showTotal: boolean
  onToggle?: () => void
  className?: string
}

/**
 * Total time since first start badge with holographic neon effect
 */
export const TotalTimeBadge = memo(function TotalTimeBadge({
  totalTimeMs,
  showTotal,
  onToggle,
  className,
}: TotalTimeBadgeProps) {
  const formattedTotal = useMemo(() => {
    if (totalTimeMs <= 0) return null

    const totalSeconds = Math.floor(totalTimeMs / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`
    }
    return `${seconds}s`
  }, [totalTimeMs])

  if (!formattedTotal) return null

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* Toggle button */}
      {onToggle && (
        <button
          onClick={onToggle}
          className={cn(
            'p-1.5 rounded-lg transition-all duration-200',
            showTotal
              ? 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30'
              : 'bg-gray-500/20 text-gray-500 hover:bg-gray-500/30'
          )}
          title={showTotal ? 'Hide total time' : 'Show total time'}
        >
          {showTotal ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
      )}

      {/* Total time badge */}
      {showTotal && (
        <div
          className={cn(
            'relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg',
            'bg-gradient-to-r from-cyan-500/10 via-purple-500/10 to-cyan-500/10',
            'border border-cyan-500/30',
            'overflow-hidden'
          )}
        >
          {/* Holographic shimmer effect */}
          <div
            className={cn(
              'absolute inset-0 opacity-30',
              'bg-gradient-to-r from-transparent via-cyan-400/20 to-transparent',
              'animate-shimmer'
            )}
            style={{
              backgroundSize: '200% 100%',
              animation: 'shimmer 3s ease-in-out infinite',
            }}
          />

          <Clock className="h-3.5 w-3.5 text-cyan-400 relative z-10" />
          <span className="text-xs font-mono text-cyan-400 relative z-10 tracking-wide">
            TOTAL: {formattedTotal}
          </span>
        </div>
      )}
    </div>
  )
})

// Add shimmer animation to styles
const shimmerStyles = `
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
`

// Inject styles
if (typeof document !== 'undefined') {
  const styleId = 'timer-shimmer-styles'
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = shimmerStyles
    document.head.appendChild(style)
  }
}
