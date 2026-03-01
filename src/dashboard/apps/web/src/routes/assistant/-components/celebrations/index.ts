/**
 * Celebration system exports
 *
 * Graduated celebration system with 3 tiers:
 * - Tier 1 (Micro): Toast notifications, bottom-right, 3s auto-dismiss
 * - Tier 2 (Badge): Center notifications, 5s, click to dismiss
 * - Tier 3 (Full): Full-screen modal with confetti
 */

export { BadgeCelebration, useBadgeCelebrations } from "./BadgeCelebration";
export {
    CelebrationManagerProvider,
    CelebrationSettings,
    celebrationManagerStore,
    useCelebrationManager,
} from "./CelebrationManager";
export { createFocusSessionCelebration, FocusSessionComplete } from "./FocusSessionComplete";
// Components
export { MicroCelebration, useMicroCelebrations } from "./MicroCelebration";
// Particles
export {
    createBurstFromElement,
    createParticles,
    PARTICLE_COLORS,
    type Particle,
    type ParticleColorScheme,
    renderParticles,
    updateParticles,
} from "./particles";
export {
    createStreakMilestoneCelebration,
    isStreakMilestone,
    StreakMilestone,
} from "./StreakMilestone";
// Types
export type {
    BadgeCelebrationData,
    CelebrationData,
    CelebrationMode,
    CelebrationSettings as CelebrationSettingsType,
    CelebrationTrigger,
    FullCelebrationData,
    MicroCelebrationData,
    QueuedCelebration,
} from "./types";
export {
    CELEBRATION_DURATION,
    CELEBRATION_MESSAGES,
    DEFAULT_CELEBRATION_SETTINGS,
    getRandomMessage,
} from "./types";
