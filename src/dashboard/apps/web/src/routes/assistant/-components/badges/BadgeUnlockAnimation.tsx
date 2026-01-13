import { useState, useEffect, useRef } from 'react'
import * as Icons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Badge, BadgeRarity } from '@/lib/assistant/types'
import { BADGE_DEFINITIONS } from '@/lib/assistant/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface BadgeUnlockAnimationProps {
  /** Badge that was unlocked */
  badge: Badge | null
  /** Whether the modal is open */
  open: boolean
  /** Close handler */
  onClose: () => void
  /** Share handler */
  onShare?: (badge: Badge) => void
}

/**
 * Rarity configuration for unlock animation
 */
const rarityUnlockConfig: Record<
  BadgeRarity,
  {
    primary: string
    secondary: string
    glow: string
    particles: string[]
    title: string
  }
> = {
  common: {
    primary: '#9CA3AF', // gray-400
    secondary: '#6B7280', // gray-500
    glow: 'rgba(156, 163, 175, 0.3)',
    particles: ['#9CA3AF', '#D1D5DB', '#E5E7EB'],
    title: 'Badge Unlocked!',
  },
  uncommon: {
    primary: '#4ADE80', // green-400
    secondary: '#22C55E', // green-500
    glow: 'rgba(74, 222, 128, 0.4)',
    particles: ['#4ADE80', '#86EFAC', '#BBF7D0'],
    title: 'Nice One!',
  },
  rare: {
    primary: '#C084FC', // purple-400
    secondary: '#A855F7', // purple-500
    glow: 'rgba(192, 132, 252, 0.5)',
    particles: ['#C084FC', '#D8B4FE', '#E9D5FF'],
    title: 'Rare Badge!',
  },
  legendary: {
    primary: '#FBBF24', // amber-400
    secondary: '#F59E0B', // amber-500
    glow: 'rgba(251, 191, 36, 0.6)',
    particles: ['#FBBF24', '#FCD34D', '#FDE68A', '#FEF3C7'],
    title: 'LEGENDARY!',
  },
}

/**
 * Get Lucide icon component by name
 */
function getIconComponent(iconName: string): Icons.LucideIcon {
  const icon = (Icons as Record<string, Icons.LucideIcon>)[iconName]
  return icon ?? Icons.Award
}

interface Particle {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  size: number
  color: string
  opacity: number
  rotation: number
  rotationSpeed: number
}

/**
 * Confetti particle system
 */
function ConfettiCanvas({
  active,
  colors,
  className,
}: {
  active: boolean
  colors: string[]
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<Particle[]>([])
  const animationRef = useRef<number>(0)

  useEffect(() => {
    if (!active || !canvasRef.current) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * 2
    canvas.height = rect.height * 2
    ctx.scale(2, 2)

    // Create particles
    const particles: Particle[] = []
    const centerX = rect.width / 2
    const centerY = rect.height / 2

    for (let i = 0; i < 80; i++) {
      const angle = (Math.random() * Math.PI * 2)
      const speed = 3 + Math.random() * 8
      particles.push({
        id: i,
        x: centerX,
        y: centerY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3,
        size: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        opacity: 1,
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 10,
      })
    }
    particlesRef.current = particles

    // Animation loop
    let lastTime = performance.now()
    function animate(currentTime: number) {
      const deltaTime = (currentTime - lastTime) / 16.67 // Normalize to ~60fps
      lastTime = currentTime

      ctx.clearRect(0, 0, rect.width, rect.height)

      particlesRef.current = particlesRef.current.filter((p) => {
        // Update position
        p.x += p.vx * deltaTime
        p.y += p.vy * deltaTime
        p.vy += 0.15 * deltaTime // Gravity
        p.opacity -= 0.012 * deltaTime
        p.rotation += p.rotationSpeed * deltaTime

        if (p.opacity <= 0) return false

        // Draw particle
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate((p.rotation * Math.PI) / 180)
        ctx.globalAlpha = p.opacity
        ctx.fillStyle = p.color
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6)
        ctx.restore()

        return true
      })

      if (particlesRef.current.length > 0) {
        animationRef.current = requestAnimationFrame(animate)
      }
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [active, colors])

  return (
    <canvas
      ref={canvasRef}
      className={cn('absolute inset-0 pointer-events-none', className)}
    />
  )
}

/**
 * BadgeUnlockAnimation - Celebration overlay when badge is earned
 *
 * Features:
 * - Confetti particle burst
 * - Badge flies in with scale animation
 * - Rarity-colored glow effects
 * - Share button
 */
export function BadgeUnlockAnimation({
  badge,
  open,
  onClose,
  onShare,
}: BadgeUnlockAnimationProps) {
  const [showConfetti, setShowConfetti] = useState(false)
  const [showBadge, setShowBadge] = useState(false)

  // Get badge definition
  const definition = badge
    ? BADGE_DEFINITIONS.find((b) => b.type === badge.badgeType)
    : null

  const rarity = badge?.rarity ?? 'common'
  const config = rarityUnlockConfig[rarity]
  const IconComponent = definition ? getIconComponent(definition.icon) : Icons.Award

  // Trigger animations when opened
  useEffect(() => {
    if (open) {
      // Start confetti immediately
      setShowConfetti(true)

      // Badge flies in after a short delay
      const badgeTimer = setTimeout(() => {
        setShowBadge(true)
      }, 200)

      return () => {
        clearTimeout(badgeTimer)
      }
    } else {
      setShowConfetti(false)
      setShowBadge(false)
    }
  }, [open])

  // Handle share
  function handleShare() {
    if (badge && onShare) {
      onShare(badge)
    }
  }

  // Copy share text to clipboard
  async function handleCopyShare() {
    if (!badge || !definition) return

    const shareText = `I just earned the "${definition.displayName}" badge! ${definition.description}`

    try {
      await navigator.clipboard.writeText(shareText)
      // Could show a toast here
    } catch {
      // Fallback or error handling
    }
  }

  if (!badge || !definition) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className={cn(
          'sm:max-w-md overflow-hidden',
          'bg-[#0a0a14]/95 border-gray-800'
        )}
      >
        {/* Confetti */}
        <ConfettiCanvas active={showConfetti} colors={config.particles} />

        {/* Glow backdrop */}
        <div
          className="absolute inset-0 opacity-30 blur-3xl pointer-events-none"
          style={{
            background: `radial-gradient(circle at center, ${config.glow} 0%, transparent 70%)`,
          }}
        />

        <DialogHeader className="relative text-center pt-4">
          <DialogTitle
            className={cn(
              'text-2xl font-bold tracking-wide',
              rarity === 'legendary' && 'animate-pulse'
            )}
            style={{ color: config.primary }}
          >
            {config.title}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            You've earned a new badge
          </DialogDescription>
        </DialogHeader>

        {/* Badge display */}
        <div className="relative flex flex-col items-center py-8">
          {/* Badge container with animation */}
          <div
            className={cn(
              'relative transition-all duration-700 ease-out',
              showBadge
                ? 'scale-100 opacity-100 translate-y-0'
                : 'scale-50 opacity-0 translate-y-8'
            )}
          >
            {/* Outer glow ring */}
            <div
              className={cn(
                'absolute inset-0 rounded-2xl blur-xl transition-opacity duration-1000',
                showBadge ? 'opacity-60' : 'opacity-0'
              )}
              style={{ backgroundColor: config.glow }}
            />

            {/* Badge card */}
            <div
              className="relative w-32 h-32 rounded-2xl border-2 flex items-center justify-center"
              style={{
                backgroundColor: `${config.primary}15`,
                borderColor: `${config.primary}50`,
                boxShadow: `0 0 40px ${config.glow}, inset 0 0 20px ${config.glow}`,
              }}
            >
              {/* Legendary shimmer effect */}
              {rarity === 'legendary' && (
                <div
                  className="absolute inset-0 rounded-2xl animate-pulse"
                  style={{
                    background: `linear-gradient(135deg, transparent 0%, ${config.glow} 50%, transparent 100%)`,
                    animationDuration: '2s',
                  }}
                />
              )}

              {/* Corner decorations */}
              <div
                className="absolute top-0 left-0 w-4 h-4 border-l-2 border-t-2 rounded-tl-lg"
                style={{ borderColor: config.primary }}
              />
              <div
                className="absolute top-0 right-0 w-4 h-4 border-r-2 border-t-2 rounded-tr-lg"
                style={{ borderColor: config.primary }}
              />
              <div
                className="absolute bottom-0 left-0 w-4 h-4 border-l-2 border-b-2 rounded-bl-lg"
                style={{ borderColor: config.primary }}
              />
              <div
                className="absolute bottom-0 right-0 w-4 h-4 border-r-2 border-b-2 rounded-br-lg"
                style={{ borderColor: config.primary }}
              />

              {/* Icon */}
              <IconComponent
                className="h-14 w-14 relative z-10"
                style={{ color: config.primary }}
              />
            </div>
          </div>

          {/* Badge info */}
          <div
            className={cn(
              'mt-6 text-center transition-all duration-500 delay-300',
              showBadge ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            )}
          >
            <h3 className="text-xl font-bold mb-1" style={{ color: config.primary }}>
              {definition.displayName}
            </h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              {definition.description}
            </p>
            <p
              className="mt-2 text-xs uppercase tracking-wider font-semibold"
              style={{ color: config.secondary }}
            >
              {rarity} Badge
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="relative flex gap-3 justify-center pb-4">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyShare}
            className="gap-2"
          >
            <Icons.Share2 className="h-4 w-4" />
            Share
          </Button>
          <Button
            size="sm"
            onClick={onClose}
            style={{
              backgroundColor: config.primary,
              color: '#0a0a14',
            }}
            className="hover:brightness-110"
          >
            Awesome!
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * useBadgeUnlock - Hook to manage badge unlock state
 */
export function useBadgeUnlock() {
  const [unlockedBadge, setUnlockedBadge] = useState<Badge | null>(null)
  const [isOpen, setIsOpen] = useState(false)

  function showUnlock(badge: Badge) {
    setUnlockedBadge(badge)
    setIsOpen(true)
  }

  function closeUnlock() {
    setIsOpen(false)
    // Clear badge after animation
    setTimeout(() => setUnlockedBadge(null), 300)
  }

  return {
    unlockedBadge,
    isOpen,
    showUnlock,
    closeUnlock,
  }
}
