import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type FeatureCardColor = 'cyan' | 'purple' | 'amber' | 'emerald' | 'rose' | 'blue' | 'primary'

interface FeatureCardProps {
  /** Color theme */
  color?: FeatureCardColor
  /** Click handler */
  onClick?: () => void
  /** Additional class names */
  className?: string
  /** Children content */
  children?: React.ReactNode
}

const colorClasses: Record<FeatureCardColor, {
  border: string
  corner: string
  glow: string
  shadow: string
}> = {
  cyan: {
    border: 'border-cyan-500/20 hover:border-cyan-500/40',
    corner: 'border-cyan-500/30 group-hover:border-cyan-500/60',
    glow: 'bg-cyan-500/10',
    shadow: 'hover:shadow-lg hover:shadow-cyan-500/10',
  },
  purple: {
    border: 'border-purple-500/20 hover:border-purple-500/40',
    corner: 'border-purple-500/30 group-hover:border-purple-500/60',
    glow: 'bg-purple-500/10',
    shadow: 'hover:shadow-lg hover:shadow-purple-500/10',
  },
  amber: {
    border: 'border-amber-500/20 hover:border-amber-500/40',
    corner: 'border-amber-500/30 group-hover:border-amber-500/60',
    glow: 'bg-amber-500/10',
    shadow: 'hover:shadow-lg hover:shadow-amber-500/10',
  },
  emerald: {
    border: 'border-emerald-500/20 hover:border-emerald-500/40',
    corner: 'border-emerald-500/30 group-hover:border-emerald-500/60',
    glow: 'bg-emerald-500/10',
    shadow: 'hover:shadow-lg hover:shadow-emerald-500/10',
  },
  rose: {
    border: 'border-rose-500/20 hover:border-rose-500/40',
    corner: 'border-rose-500/30 group-hover:border-rose-500/60',
    glow: 'bg-rose-500/10',
    shadow: 'hover:shadow-lg hover:shadow-rose-500/10',
  },
  blue: {
    border: 'border-blue-500/20 hover:border-blue-500/40',
    corner: 'border-blue-500/30 group-hover:border-blue-500/60',
    glow: 'bg-blue-500/10',
    shadow: 'hover:shadow-lg hover:shadow-blue-500/10',
  },
  primary: {
    border: 'border-primary/20 hover:border-primary/40',
    corner: 'border-primary/30 group-hover:border-primary/60',
    glow: 'bg-primary/10',
    shadow: 'hover:shadow-lg hover:shadow-primary/10',
  },
}

/**
 * A cyberpunk-styled feature card with colored borders and corner decorations.
 * Matches the original Card styling exactly.
 *
 * @example
 * <FeatureCard color="purple" className="max-w-lg">
 *   <FeatureCardHeader className="text-center">
 *     <div className="p-4 rounded-2xl bg-purple-500/10 border border-purple-500/20">
 *       <Brain className="h-12 w-12 text-purple-400" />
 *     </div>
 *     <FeatureCardTitle>AI Assistant</FeatureCardTitle>
 *     <FeatureCardDescription>Your personal AI companion</FeatureCardDescription>
 *   </FeatureCardHeader>
 *   <FeatureCardContent>
 *     {content}
 *   </FeatureCardContent>
 * </FeatureCard>
 */
export function FeatureCard({
  color = 'primary',
  onClick,
  className,
  children,
}: FeatureCardProps) {
  const colors = colorClasses[color]

  const Wrapper = onClick ? 'button' : 'div'

  return (
    <Wrapper
      onClick={onClick}
      className={cn(
        'group relative overflow-hidden rounded-xl',
        'bg-[#0a0a14]/80 backdrop-blur-sm',
        'border',
        colors.border,
        colors.shadow,
        'transition-all duration-300',
        onClick && 'cursor-pointer',
        className
      )}
    >
      {/* Tech corner decorations */}
      <div className={cn('absolute top-0 left-0 w-6 h-6 border-l-2 border-t-2 rounded-tl transition-colors', colors.corner)} />
      <div className={cn('absolute top-0 right-0 w-6 h-6 border-r-2 border-t-2 rounded-tr transition-colors', colors.corner)} />
      <div className={cn('absolute bottom-0 left-0 w-6 h-6 border-l-2 border-b-2 rounded-bl transition-colors', colors.corner)} />
      <div className={cn('absolute bottom-0 right-0 w-6 h-6 border-r-2 border-b-2 rounded-br transition-colors', colors.corner)} />

      {/* Glow effect */}
      <div
        className={cn(
          'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full blur-3xl',
          colors.glow
        )}
      />

      {/* Content */}
      {children}
    </Wrapper>
  )
}

/**
 * Header section for FeatureCard
 */
export function FeatureCardHeader({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex flex-col space-y-1.5 p-6 relative', className)}>
      {children}
    </div>
  )
}

/**
 * Title for FeatureCard
 */
export function FeatureCardTitle({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <h3 className={cn('text-2xl font-semibold leading-none tracking-tight', className)}>
      {children}
    </h3>
  )
}

/**
 * Description for FeatureCard
 */
export function FeatureCardDescription({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <p className={cn('text-sm text-muted-foreground', className)}>
      {children}
    </p>
  )
}

/**
 * Content section for FeatureCard
 */
export function FeatureCardContent({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('p-6 pt-0 relative', className)}>
      {children}
    </div>
  )
}

export { colorClasses as featureCardColors }
