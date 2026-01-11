import { useEffect, useRef, useState } from 'react'
import { Trophy, Flame, Star, ArrowRight, Coffee, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog'
import type { Task, Badge, Streak } from '../-types'

interface CelebrationModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task | null
  newBadges: Badge[]
  streak: Streak | null
  totalCompleted: number
  onNextTask?: () => void
  onRest?: () => void
}

/**
 * Canvas-based confetti animation
 */
function useConfetti(canvasRef: React.RefObject<HTMLCanvasElement>, isActive: boolean) {
  useEffect(() => {
    if (!isActive || !canvasRef.current) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set canvas size
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight

    // Confetti particles
    const particles: Array<{
      x: number
      y: number
      vx: number
      vy: number
      color: string
      size: number
      rotation: number
      rotationSpeed: number
    }> = []

    // Colors (purple theme)
    const colors = [
      '#a855f7', // purple-500
      '#c084fc', // purple-400
      '#d8b4fe', // purple-300
      '#f59e0b', // amber-500
      '#fbbf24', // amber-400
      '#34d399', // emerald-400
      '#f472b6', // pink-400
    ]

    // Create particles
    for (let i = 0; i < 150; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * 100,
        vx: (Math.random() - 0.5) * 8,
        vy: Math.random() * 3 + 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: Math.random() * 8 + 4,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.2,
      })
    }

    let animationId: number

    function animate() {
      if (!ctx || !canvas) return

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      let activeParticles = 0

      for (const particle of particles) {
        if (particle.y < canvas.height + 50) {
          activeParticles++

          // Update
          particle.x += particle.vx
          particle.y += particle.vy
          particle.vy += 0.1 // gravity
          particle.rotation += particle.rotationSpeed

          // Draw
          ctx.save()
          ctx.translate(particle.x, particle.y)
          ctx.rotate(particle.rotation)
          ctx.fillStyle = particle.color
          ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size)
          ctx.restore()
        }
      }

      if (activeParticles > 0) {
        animationId = requestAnimationFrame(animate)
      }
    }

    animate()

    return () => {
      if (animationId) {
        cancelAnimationFrame(animationId)
      }
    }
  }, [isActive, canvasRef])
}

/**
 * CelebrationModal - Full-screen celebration on task completion
 */
export function CelebrationModal({
  open,
  onOpenChange,
  task,
  newBadges,
  streak,
  totalCompleted,
  onNextTask,
  onRest,
}: CelebrationModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [showContent, setShowContent] = useState(false)

  // Trigger confetti when modal opens
  useConfetti(canvasRef, open)

  // Delay content appearance for dramatic effect
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => setShowContent(true), 200)
      return () => clearTimeout(timer)
    } else {
      setShowContent(false)
    }
  }, [open])

  if (!task) return null

  const urgencyMessage = {
    critical: 'CRITICAL TASK DONE! You\'re on track!',
    important: 'Great progress on an important task!',
    'nice-to-have': 'Nice work on that stretch goal!',
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] bg-transparent border-0 shadow-none overflow-visible">
        {/* Confetti canvas */}
        <canvas
          ref={canvasRef}
          className="fixed inset-0 pointer-events-none z-50"
          style={{ width: '100vw', height: '100vh' }}
        />

        {/* Content */}
        <div
          className={cn(
            'relative bg-card rounded-2xl border border-purple-500/30 p-8 text-center',
            'transition-all duration-500',
            showContent ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
          )}
        >
          {/* Glow effect */}
          <div className="absolute inset-0 bg-gradient-to-b from-purple-500/20 to-transparent rounded-2xl" />

          {/* Trophy icon */}
          <div className="relative mb-6">
            <div className="w-24 h-24 mx-auto rounded-full bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center animate-bounce-slow">
              <Trophy className="h-12 w-12 text-black" />
            </div>
            <Sparkles className="absolute top-0 right-1/4 h-6 w-6 text-purple-400 animate-pulse" />
            <Sparkles className="absolute bottom-0 left-1/4 h-5 w-5 text-amber-400 animate-pulse" />
          </div>

          {/* Title */}
          <h2 className="relative text-3xl font-bold mb-2 bg-gradient-to-r from-purple-400 to-amber-400 text-transparent bg-clip-text">
            YOU DID IT!
          </h2>

          {/* Task title */}
          <p className="relative text-lg text-foreground/90 mb-4 line-clamp-2">
            "{task.title}"
          </p>

          {/* Urgency-specific message */}
          <p className="relative text-sm text-muted-foreground mb-6">
            {urgencyMessage[task.urgencyLevel]}
          </p>

          {/* Stats row */}
          <div className="relative flex justify-center gap-6 mb-6">
            {/* Streak */}
            {streak && streak.currentStreakDays > 0 && (
              <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-orange-500/10 border border-orange-500/30">
                <Flame className="h-5 w-5 text-orange-400" />
                <span className="font-semibold text-orange-400">
                  {streak.currentStreakDays}-day streak
                </span>
              </div>
            )}

            {/* Total completed */}
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-purple-500/10 border border-purple-500/30">
              <Star className="h-5 w-5 text-purple-400" />
              <span className="font-semibold text-purple-400">
                {totalCompleted} task{totalCompleted !== 1 ? 's' : ''} done
              </span>
            </div>
          </div>

          {/* New badges */}
          {newBadges.length > 0 && (
            <div className="relative mb-6 p-4 rounded-xl bg-gradient-to-r from-amber-500/10 to-purple-500/10 border border-amber-500/30">
              <p className="text-xs uppercase tracking-wider text-amber-400 font-semibold mb-3">
                New Badge Unlocked!
              </p>
              <div className="flex justify-center gap-4">
                {newBadges.map((badge) => (
                  <div key={badge.id} className="flex flex-col items-center">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center mb-2">
                      <Trophy className="h-6 w-6 text-black" />
                    </div>
                    <span className="text-sm font-semibold text-foreground">
                      {badge.displayName}
                    </span>
                    <span
                      className={cn(
                        'text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded mt-1',
                        badge.rarity === 'legendary' && 'text-amber-400 bg-amber-500/20',
                        badge.rarity === 'rare' && 'text-purple-400 bg-purple-500/20',
                        badge.rarity === 'uncommon' && 'text-green-400 bg-green-500/20',
                        badge.rarity === 'common' && 'text-gray-400 bg-gray-500/20'
                      )}
                    >
                      {badge.rarity}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="relative flex justify-center gap-3">
            {onNextTask && (
              <Button
                onClick={() => {
                  onOpenChange(false)
                  onNextTask()
                }}
                className="gap-2 bg-purple-600 hover:bg-purple-700"
              >
                Next task
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
            {onRest && (
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false)
                  onRest()
                }}
                className="gap-2"
              >
                <Coffee className="h-4 w-4" />
                Take a break
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Back to tasks
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
