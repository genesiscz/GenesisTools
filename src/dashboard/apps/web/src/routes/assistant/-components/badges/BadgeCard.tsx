import * as Icons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Badge, BadgeRarity, BadgeType } from '@/lib/assistant/types'
import { BADGE_DEFINITIONS } from '@/lib/assistant/types'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface BadgeCardProps {
  /** Earned badge data, or badge definition for preview */
  badge?: Badge
  /** Badge type for showing locked/unearned preview */
  badgeType?: BadgeType
  /** Whether badge is earned */
  earned?: boolean
  /** Size variant */
  size?: 'sm' | 'md' | 'lg'
  /** Show badge name under icon */
  showName?: boolean
  /** Click handler */
  onClick?: () => void
  /** Additional class names */
  className?: string
}

/**
 * Rarity color configuration for cyberpunk styling
 */
const rarityConfig: Record<
  BadgeRarity,
  {
    iconColor: string
    bgColor: string
    borderColor: string
    glowColor: string
    shadowStyle: string
    labelColor: string
  }
> = {
  common: {
    iconColor: 'text-gray-400',
    bgColor: 'bg-gray-500/10',
    borderColor: 'border-gray-500/30',
    glowColor: '',
    shadowStyle: '',
    labelColor: 'text-gray-400',
  },
  uncommon: {
    iconColor: 'text-green-400',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/30',
    glowColor: 'bg-green-500/5',
    shadowStyle: 'shadow-green-500/20',
    labelColor: 'text-green-400',
  },
  rare: {
    iconColor: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500/30',
    glowColor: 'bg-purple-500/5',
    shadowStyle: 'shadow-purple-500/20',
    labelColor: 'text-purple-400',
  },
  legendary: {
    iconColor: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/40',
    glowColor: 'bg-amber-500/10',
    shadowStyle: 'shadow-amber-500/30',
    labelColor: 'text-amber-400',
  },
}

const sizeConfig = {
  sm: {
    container: 'w-12 h-12',
    icon: 'h-5 w-5',
    text: 'text-[10px]',
    padding: 'p-2',
  },
  md: {
    container: 'w-16 h-16',
    icon: 'h-7 w-7',
    text: 'text-xs',
    padding: 'p-3',
  },
  lg: {
    container: 'w-20 h-20',
    icon: 'h-9 w-9',
    text: 'text-sm',
    padding: 'p-4',
  },
}

/**
 * Get Lucide icon component by name
 */
function getIconComponent(iconName: string): Icons.LucideIcon {
  const icon = (Icons as Record<string, Icons.LucideIcon>)[iconName]
  return icon ?? Icons.Award
}

/**
 * BadgeCard - Display a single badge with rarity styling
 *
 * Supports both earned badges and locked badge previews.
 * Legendary badges feature a pulsing gold shimmer effect.
 */
export function BadgeCard({
  badge,
  badgeType,
  earned = true,
  size = 'md',
  showName = false,
  onClick,
  className,
}: BadgeCardProps) {
  // Get badge definition
  const type = badge?.badgeType ?? badgeType
  const definition = type ? BADGE_DEFINITIONS.find((b) => b.type === type) : null

  if (!definition) {
    return null
  }

  const rarity = badge?.rarity ?? definition.rarity
  const displayName = badge?.displayName ?? definition.displayName
  const config = rarityConfig[rarity]
  const sizeClasses = sizeConfig[size]
  const IconComponent = getIconComponent(definition.icon)

  const isLegendary = rarity === 'legendary'
  const isClickable = !!onClick

  // Format earned date
  const earnedDate = badge?.earnedAt
    ? new Date(badge.earnedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null

  const badgeElement = (
    <div
      className={cn(
        'relative flex flex-col items-center gap-1',
        isClickable && 'cursor-pointer',
        className
      )}
      onClick={onClick}
    >
      {/* Badge icon container */}
      <div
        className={cn(
          'relative rounded-xl border transition-all duration-300',
          sizeClasses.container,
          sizeClasses.padding,
          config.bgColor,
          config.borderColor,
          earned && 'hover:scale-105',
          !earned && 'opacity-40 grayscale',
          isClickable && 'hover:brightness-110',
          // Legendary glow effect
          isLegendary && earned && [
            'shadow-lg',
            config.shadowStyle,
          ]
        )}
        style={
          isLegendary && earned
            ? {
                boxShadow: '0 0 20px rgba(251, 191, 36, 0.3), inset 0 0 15px rgba(251, 191, 36, 0.1)',
              }
            : undefined
        }
      >
        {/* Legendary pulse animation */}
        {isLegendary && earned && (
          <div
            className="absolute inset-0 rounded-xl animate-pulse"
            style={{
              background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.1) 0%, transparent 50%, rgba(251, 191, 36, 0.1) 100%)',
              animationDuration: '2s',
            }}
          />
        )}

        {/* Tech corner decorations for rare+ badges */}
        {(rarity === 'rare' || rarity === 'legendary') && earned && (
          <>
            <div className={cn('absolute top-0 left-0 w-2 h-2 border-l border-t rounded-tl', config.borderColor)} />
            <div className={cn('absolute top-0 right-0 w-2 h-2 border-r border-t rounded-tr', config.borderColor)} />
            <div className={cn('absolute bottom-0 left-0 w-2 h-2 border-l border-b rounded-bl', config.borderColor)} />
            <div className={cn('absolute bottom-0 right-0 w-2 h-2 border-r border-b rounded-br', config.borderColor)} />
          </>
        )}

        {/* Icon */}
        <IconComponent
          className={cn(
            'relative z-10',
            sizeClasses.icon,
            earned ? config.iconColor : 'text-gray-600'
          )}
        />

        {/* Lock overlay for unearned */}
        {!earned && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Icons.Lock className="h-4 w-4 text-gray-500" />
          </div>
        )}
      </div>

      {/* Badge name */}
      {showName && (
        <span
          className={cn(
            'font-medium text-center max-w-full truncate',
            sizeClasses.text,
            earned ? config.labelColor : 'text-gray-500'
          )}
        >
          {displayName}
        </span>
      )}
    </div>
  )

  // Wrap with tooltip
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {badgeElement}
      </TooltipTrigger>
      <TooltipContent
        className={cn(
          'max-w-xs p-3 space-y-2',
          'bg-[#0a0a14]/95 border',
          config.borderColor
        )}
      >
        <div className="flex items-center gap-2">
          <IconComponent className={cn('h-4 w-4', config.iconColor)} />
          <span className={cn('font-semibold', config.labelColor)}>
            {displayName}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {definition.description}
        </p>
        <div className="flex items-center justify-between text-[10px]">
          <span className={cn('uppercase tracking-wider font-medium', config.labelColor)}>
            {rarity}
          </span>
          {earnedDate && (
            <span className="text-muted-foreground">
              Earned {earnedDate}
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * BadgeCardCompact - Smaller inline badge for lists
 */
export function BadgeCardCompact({
  badge,
  badgeType,
  earned = true,
  className,
}: Pick<BadgeCardProps, 'badge' | 'badgeType' | 'earned' | 'className'>) {
  return (
    <BadgeCard
      badge={badge}
      badgeType={badgeType}
      earned={earned}
      size="sm"
      showName={false}
      className={className}
    />
  )
}

/**
 * BadgeCardLarge - Featured badge display
 */
export function BadgeCardLarge({
  badge,
  badgeType,
  earned = true,
  onClick,
  className,
}: Pick<BadgeCardProps, 'badge' | 'badgeType' | 'earned' | 'onClick' | 'className'>) {
  return (
    <BadgeCard
      badge={badge}
      badgeType={badgeType}
      earned={earned}
      size="lg"
      showName={true}
      onClick={onClick}
      className={className}
    />
  )
}
