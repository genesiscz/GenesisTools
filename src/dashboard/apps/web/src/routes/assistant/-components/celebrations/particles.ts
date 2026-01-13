/**
 * Particle animation utilities for celebrations
 */

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  color: string
  rotation: number
  rotationSpeed: number
  opacity: number
  life: number
  maxLife: number
}

/**
 * Celebration color palettes
 */
export const PARTICLE_COLORS = {
  emerald: ['#10b981', '#34d399', '#6ee7b7', '#a7f3d0'],
  amber: ['#f59e0b', '#fbbf24', '#fcd34d', '#fde68a'],
  purple: ['#a855f7', '#c084fc', '#d8b4fe', '#e9d5ff'],
  mixed: ['#10b981', '#f59e0b', '#a855f7', '#f472b6', '#22d3ee'],
} as const

export type ParticleColorScheme = keyof typeof PARTICLE_COLORS

/**
 * Create initial particles for a celebration
 */
export function createParticles(
  count: number,
  originX: number,
  originY: number,
  colorScheme: ParticleColorScheme = 'mixed'
): Particle[] {
  const colors = PARTICLE_COLORS[colorScheme]
  const particles: Particle[] = []

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5
    const velocity = 3 + Math.random() * 5
    const life = 60 + Math.random() * 40

    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * velocity,
      vy: Math.sin(angle) * velocity - 3, // Initial upward bias
      size: 4 + Math.random() * 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 0.2,
      opacity: 1,
      life,
      maxLife: life,
    })
  }

  return particles
}

/**
 * Update particles for one animation frame
 */
export function updateParticles(particles: Particle[]): Particle[] {
  return particles
    .map((p) => ({
      ...p,
      x: p.x + p.vx,
      y: p.y + p.vy,
      vy: p.vy + 0.15, // Gravity
      vx: p.vx * 0.99, // Air resistance
      rotation: p.rotation + p.rotationSpeed,
      life: p.life - 1,
      opacity: Math.min(1, p.life / (p.maxLife * 0.3)),
    }))
    .filter((p) => p.life > 0)
}

/**
 * Render particles to a canvas context
 */
export function renderParticles(
  ctx: CanvasRenderingContext2D,
  particles: Particle[]
): void {
  for (const p of particles) {
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(p.rotation)
    ctx.globalAlpha = p.opacity
    ctx.fillStyle = p.color

    // Draw a simple rectangle particle
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size)

    ctx.restore()
  }
}

/**
 * Create a burst animation from an element
 */
export function createBurstFromElement(
  element: HTMLElement,
  colorScheme: ParticleColorScheme = 'mixed',
  count: number = 30
): Particle[] {
  const rect = element.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2

  return createParticles(count, centerX, centerY, colorScheme)
}

/**
 * CSS keyframe animation for simple particle effects
 * Use this instead of canvas for simpler effects
 */
export const particleKeyframes = `
  @keyframes particle-float {
    0% {
      opacity: 1;
      transform: translateY(0) scale(1) rotate(0deg);
    }
    100% {
      opacity: 0;
      transform: translateY(-100px) scale(0.5) rotate(180deg);
    }
  }

  @keyframes particle-burst {
    0% {
      opacity: 1;
      transform: scale(0);
    }
    50% {
      opacity: 1;
      transform: scale(1.2);
    }
    100% {
      opacity: 0;
      transform: scale(0.8);
    }
  }

  @keyframes glow-pulse {
    0%, 100% {
      box-shadow: 0 0 5px currentColor, 0 0 10px currentColor;
    }
    50% {
      box-shadow: 0 0 15px currentColor, 0 0 30px currentColor;
    }
  }

  @keyframes shimmer {
    0% {
      background-position: -200% center;
    }
    100% {
      background-position: 200% center;
    }
  }
`

/**
 * Generate CSS for floating particles (no canvas required)
 */
export function generateCSSParticles(count: number, colors: string[]): string {
  const particles: string[] = []

  for (let i = 0; i < count; i++) {
    const color = colors[Math.floor(Math.random() * colors.length)]
    const delay = Math.random() * 0.5
    const duration = 0.8 + Math.random() * 0.4
    const x = Math.random() * 100
    const size = 4 + Math.random() * 4

    particles.push(`
      .particle-${i} {
        position: absolute;
        left: ${x}%;
        bottom: 0;
        width: ${size}px;
        height: ${size}px;
        background: ${color};
        border-radius: 2px;
        animation: particle-float ${duration}s ease-out ${delay}s forwards;
      }
    `)
  }

  return particles.join('\n')
}
