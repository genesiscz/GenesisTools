/**
 * Celebration system exports
 *
 * Graduated celebration system with 3 tiers:
 * - Tier 1 (Micro): Toast notifications, bottom-right, 3s auto-dismiss
 * - Tier 2 (Badge): Center notifications, 5s, click to dismiss
 * - Tier 3 (Full): Full-screen modal with confetti
 */

// Components
export { MicroCelebration, useMicroCelebrations } from './MicroCelebration'
export { BadgeCelebration, useBadgeCelebrations } from './BadgeCelebration'
export { FocusSessionComplete, createFocusSessionCelebration } from './FocusSessionComplete'
export {
  StreakMilestone,
  createStreakMilestoneCelebration,
  isStreakMilestone,
} from './StreakMilestone'
export {
  CelebrationManagerProvider,
  useCelebrationManager,
  CelebrationSettings,
  celebrationManagerStore,
} from './CelebrationManager'

// Types
export type {
  CelebrationMode,
  CelebrationTrigger,
  CelebrationData,
  MicroCelebrationData,
  BadgeCelebrationData,
  FullCelebrationData,
  CelebrationSettings as CelebrationSettingsType,
  QueuedCelebration,
} from './types'

export {
  DEFAULT_CELEBRATION_SETTINGS,
  CELEBRATION_DURATION,
  CELEBRATION_MESSAGES,
  getRandomMessage,
} from './types'

// Particles
export {
  createParticles,
  updateParticles,
  renderParticles,
  createBurstFromElement,
  PARTICLE_COLORS,
  type Particle,
  type ParticleColorScheme,
} from './particles'
