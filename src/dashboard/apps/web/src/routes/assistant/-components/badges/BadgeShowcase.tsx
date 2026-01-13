import { Award, Trophy } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Badge, BadgeRarity } from '@/lib/assistant/types'
import { BadgeCard } from './BadgeCard'

interface BadgeShowcaseProps {
  /** List of earned badges */
  badges: Badge[]
  /** Loading state */
  loading?: boolean
  /** Filter badges by rarity */
  filterRarity?: BadgeRarity | null
  /** Callback when badge is clicked */
  onBadgeClick?: (badge: Badge) => void
  /** Additional class names */
  className?: string
}

/**
 * Rarity sort order (legendary first)
 */
const raritySortOrder: Record<BadgeRarity, number> = {
  legendary: 0,
  rare: 1,
  uncommon: 2,
  common: 3,
}

/**
 * BadgeShowcase - Grid display of earned badges
 *
 * Features:
 * - Responsive grid layout
 * - Badges sorted by rarity (legendary first)
 * - Empty state when no badges earned
 * - Optional rarity filtering
 */
export function BadgeShowcase({
  badges,
  loading = false,
  filterRarity,
  onBadgeClick,
  className,
}: BadgeShowcaseProps) {
  // Filter and sort badges
  const displayBadges = badges
    .filter((b) => !filterRarity || b.rarity === filterRarity)
    .sort((a, b) => raritySortOrder[a.rarity] - raritySortOrder[b.rarity])

  // Loading skeleton
  if (loading) {
    return (
      <div className={cn('space-y-4', className)}>
        <div className="flex items-center gap-2 animate-pulse">
          <div className="w-5 h-5 rounded bg-gray-700" />
          <div className="w-32 h-5 rounded bg-gray-700" />
        </div>
        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="w-16 h-16 rounded-xl bg-gray-800/50 animate-pulse"
              style={{ animationDelay: `${i * 100}ms` }}
            />
          ))}
        </div>
      </div>
    )
  }

  // Empty state
  if (displayBadges.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-12', className)}>
        <div className="w-20 h-20 rounded-full bg-gray-800/50 border border-gray-700/50 flex items-center justify-center mb-4">
          <Award className="h-10 w-10 text-gray-600" />
        </div>
        <h3 className="text-lg font-semibold text-gray-400 mb-2">
          No Badges Yet
        </h3>
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          Complete tasks and maintain streaks to earn your first badge!
        </p>
      </div>
    )
  }

  // Count badges by rarity
  const rarityCount = badges.reduce(
    (acc, b) => {
      acc[b.rarity] = (acc[b.rarity] || 0) + 1
      return acc
    },
    {} as Record<BadgeRarity, number>
  )

  return (
    <div className={cn('space-y-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-amber-400" />
          <h3 className="text-lg font-semibold">
            Earned Badges ({badges.length})
          </h3>
        </div>

        {/* Rarity breakdown */}
        <div className="hidden sm:flex items-center gap-3 text-xs">
          {rarityCount.legendary && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-amber-400">{rarityCount.legendary}</span>
            </span>
          )}
          {rarityCount.rare && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-purple-400" />
              <span className="text-purple-400">{rarityCount.rare}</span>
            </span>
          )}
          {rarityCount.uncommon && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-green-400">{rarityCount.uncommon}</span>
            </span>
          )}
          {rarityCount.common && (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              <span className="text-gray-400">{rarityCount.common}</span>
            </span>
          )}
        </div>
      </div>

      {/* Badge grid */}
      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
        {displayBadges.map((badge) => (
          <BadgeCard
            key={badge.id}
            badge={badge}
            earned={true}
            size="md"
            showName={false}
            onClick={onBadgeClick ? () => onBadgeClick(badge) : undefined}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * BadgeShowcaseCompact - Condensed badge display for sidebars/cards
 */
export function BadgeShowcaseCompact({
  badges,
  maxDisplay = 5,
  onViewAll,
  className,
}: {
  badges: Badge[]
  maxDisplay?: number
  onViewAll?: () => void
  className?: string
}) {
  const sortedBadges = [...badges].sort(
    (a, b) => raritySortOrder[a.rarity] - raritySortOrder[b.rarity]
  )
  const displayBadges = sortedBadges.slice(0, maxDisplay)
  const remaining = badges.length - maxDisplay

  if (badges.length === 0) {
    return (
      <div className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)}>
        <Award className="h-4 w-4" />
        <span>No badges earned yet</span>
      </div>
    )
  }

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {displayBadges.map((badge) => (
        <BadgeCard
          key={badge.id}
          badge={badge}
          earned={true}
          size="sm"
          showName={false}
        />
      ))}
      {remaining > 0 && (
        <button
          onClick={onViewAll}
          className="w-12 h-12 rounded-xl border border-gray-700/50 bg-gray-800/30 flex items-center justify-center text-xs text-gray-400 hover:bg-gray-800/50 transition-colors"
        >
          +{remaining}
        </button>
      )}
    </div>
  )
}
