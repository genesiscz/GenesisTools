/**
 * Default timer name
 */
export const DEFAULT_TIMER_NAME = 'Timer'

/**
 * Default countdown duration in milliseconds (5 minutes)
 */
export const DEFAULT_COUNTDOWN_DURATION = 5 * 60 * 1000

/**
 * Local storage key for timers
 */
export const TIMERS_STORAGE_KEY = 'dashboard_timers'

/**
 * WebSocket events
 */
export const WS_EVENTS = {
  TIMER_UPDATE: 'timer:update',
  TIMER_CREATE: 'timer:create',
  TIMER_DELETE: 'timer:delete',
  SYNC_REQUEST: 'sync:request',
  SYNC_RESPONSE: 'sync:response',
} as const

/**
 * API endpoints
 */
export const API_ENDPOINTS = {
  TIMERS: '/api/timers',
  HEALTH: '/api/health',
  USER: '/api/user',
  AUTH: '/api/auth',
} as const
