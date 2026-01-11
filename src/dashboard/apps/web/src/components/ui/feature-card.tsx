import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type FeatureCardColor = 'cyan' | 'purple' | 'amber' | 'emerald' | 'rose' | 'blue' | 'primary'

interface FeatureCardProps {
  /** Card title */
  title: string
  /** Card description */
  description?: string
  /** Icon component from lucide-react */
  icon?: LucideIcon
  /** Color theme */
  color?: FeatureCardColor
  /** Badge text (e.g., "Active", "Coming Soon") */
  badge?: string
  /** Whether the card is active/enabled */
  isActive?: boolean
  /** Click handler */
  onClick?: () => void
  /** Additional class names */
  className?: string
  /** Children content (replaces default layout) */
  children?: React.ReactNode
  /** Footer content */
  footer?: React.ReactNode
}

const colorClasses: Record<FeatureCardColor, {
  bg: string
  border: string
  corner: string
  icon: string
  glow: string
  badge: string
  shadow: string
}> = {
  cyan: {
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/30 hover:border-cyan-500/50',
    corner: 'border-cyan-500/40 group-hover:border-cyan-500/70',
    icon: 'text-cyan-400',
    glow: 'bg-cyan-500/15',
    badge: 'bg-cyan-500/20 text-cyan-400',
    shadow: 'hover:shadow-cyan-500/20',
  },
  purple: {
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/30 hover:border-purple-500/50',
    corner: 'border-purple-500/40 group-hover:border-purple-500/70',
    icon: 'text-purple-400',
    glow: 'bg-purple-500/15',
    badge: 'bg-purple-500/20 text-purple-400',
    shadow: 'hover:shadow-purple-500/20',
  },
  amber: {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30 hover:border-amber-500/50',
    corner: 'border-amber-500/40 group-hover:border-amber-500/70',
    icon: 'text-amber-400',
    glow: 'bg-amber-500/15',
    badge: 'bg-amber-500/20 text-amber-400',
    shadow: 'hover:shadow-amber-500/20',
  },
  emerald: {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30 hover:border-emerald-500/50',
    corner: 'border-emerald-500/40 group-hover:border-emerald-500/70',
    icon: 'text-emerald-400',
    glow: 'bg-emerald-500/15',
    badge: 'bg-emerald-500/20 text-emerald-400',
    shadow: 'hover:shadow-emerald-500/20',
  },
  rose: {
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/30 hover:border-rose-500/50',
    corner: 'border-rose-500/40 group-hover:border-rose-500/70',
    icon: 'text-rose-400',
    glow: 'bg-rose-500/15',
    badge: 'bg-rose-500/20 text-rose-400',
    shadow: 'hover:shadow-rose-500/20',
  },
  blue: {
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/30 hover:border-blue-500/50',
    corner: 'border-blue-500/40 group-hover:border-blue-500/70',
    icon: 'text-blue-400',
    glow: 'bg-blue-500/15',
    badge: 'bg-blue-500/20 text-blue-400',
    shadow: 'hover:shadow-blue-500/20',
  },
  primary: {
    bg: 'bg-primary/10',
    border: 'border-primary/30 hover:border-primary/50',
    corner: 'border-primary/40 group-hover:border-primary/70',
    icon: 'text-primary',
    glow: 'bg-primary/15',
    badge: 'bg-primary/20 text-primary',
    shadow: 'hover:shadow-primary/20',
  },
}

/**
 * A cyberpunk-styled feature card with colored borders and corner decorations.
 *
 * @example
 * // Basic usage
 * <FeatureCard
 *   title="AI Assistant"
 *   description="Your personal AI companion"
 *   icon={Brain}
 *   color="purple"
 *   badge="Coming Soon"
 * />
 *
 * @example
 * // With custom content
 * <FeatureCard color="cyan" title="Timer">
 *   <TimerDisplay time="00:00:00" />
 * </FeatureCard>
 */
export function FeatureCard({
  title,
  description,
  icon: Icon,
  color = 'primary',
  badge,
  isActive = true,
  onClick,
  className,
  children,
  footer,
}: FeatureCardProps) {
  const colors = colorClasses[color]

  const Wrapper = onClick ? 'button' : 'div'

  return (
    <Wrapper
      onClick={onClick}
      className={cn(
        'group relative rounded-xl overflow-hidden text-left w-full',
        'bg-gray-900/95',
        'backdrop-blur-md',
        'border',
        colors.border,
        'shadow-lg',
        'transition-all duration-300',
        'hover:shadow-lg',
        colors.shadow,
        onClick && 'cursor-pointer',
        !isActive && 'opacity-60',
        className
      )}
    >
      {/* Tech corner decorations */}
      <div className={cn('absolute top-0 left-0 w-5 h-5 border-l-2 border-t-2 rounded-tl-lg transition-colors', colors.corner)} />
      <div className={cn('absolute top-0 right-0 w-5 h-5 border-r-2 border-t-2 rounded-tr-lg transition-colors', colors.corner)} />
      <div className={cn('absolute bottom-0 left-0 w-5 h-5 border-l-2 border-b-2 rounded-bl-lg transition-colors', colors.corner)} />
      <div className={cn('absolute bottom-0 right-0 w-5 h-5 border-r-2 border-b-2 rounded-br-lg transition-colors', colors.corner)} />

      {/* Subtle glow */}
      <div
        className={cn(
          'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full blur-2xl pointer-events-none opacity-50',
          colors.glow
        )}
      />

      {/* Content */}
      <div className="relative p-4">
        {children ? (
          children
        ) : (
          <>
            {/* Header with icon and badge */}
            <div className="flex items-start justify-between mb-3">
              {Icon && (
                <div className={cn('p-2.5 rounded-lg', colors.bg)}>
                  <Icon className={cn('h-5 w-5', colors.icon)} />
                </div>
              )}
              {badge && (
                <span className={cn('text-[10px] font-medium px-2 py-1 rounded-full', colors.badge)}>
                  {badge}
                </span>
              )}
            </div>

            {/* Title and description */}
            <h3 className="text-base font-semibold text-foreground mb-1">{title}</h3>
            {description && (
              <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
            )}

            {/* Footer */}
            {footer && <div className="mt-4">{footer}</div>}
          </>
        )}
      </div>
    </Wrapper>
  )
}

export { colorClasses as featureCardColors }
