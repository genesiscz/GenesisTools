/**
 * FocusSessionComplete - Toast for completing a focus session
 *
 * A specialized micro celebration for completing a 25-minute focus session.
 * Uses the MicroCelebration component with focus-specific styling.
 */

import { MicroCelebration } from './MicroCelebration'
import type { MicroCelebrationData } from './types'
import { CELEBRATION_MESSAGES, getRandomMessage } from './types'

interface FocusSessionCompleteProps {
  onDismiss: () => void
  focusMinutes?: number
}

export function FocusSessionComplete({
  onDismiss,
  focusMinutes = 25,
}: FocusSessionCompleteProps) {
  const celebration: MicroCelebrationData = {
    id: `focus_${Date.now()}`,
    tier: 'micro',
    title: 'Focus Complete!',
    message:
      focusMinutes === 25
        ? getRandomMessage(CELEBRATION_MESSAGES.focusSession)
        : `${focusMinutes} minutes of focused work. Great job!`,
    trigger: 'focus-session',
    icon: 'focus',
    accent: 'purple',
  }

  return <MicroCelebration celebration={celebration} onDismiss={onDismiss} />
}

/**
 * Create focus session celebration data
 */
export function createFocusSessionCelebration(
  focusMinutes: number = 25
): Omit<MicroCelebrationData, 'id' | 'tier'> {
  return {
    title: 'Focus Complete!',
    message:
      focusMinutes === 25
        ? getRandomMessage(CELEBRATION_MESSAGES.focusSession)
        : `${focusMinutes} minutes of focused work. Great job!`,
    trigger: 'focus-session',
    icon: 'focus',
    accent: 'purple',
  }
}
