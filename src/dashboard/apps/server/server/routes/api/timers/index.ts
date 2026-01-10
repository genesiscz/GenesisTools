import { eventHandler, readBody, getMethod, createError } from 'h3'
import type { SerializedTimer } from '@dashboard/shared'

// In-memory store for timers (will be replaced with database later)
const timers = new Map<string, SerializedTimer>()

export default eventHandler(async (event) => {
  const method = getMethod(event)

  // GET /api/timers - List all timers
  if (method === 'GET') {
    return {
      timers: Array.from(timers.values()),
      total: timers.size,
    }
  }

  // POST /api/timers - Create a new timer
  if (method === 'POST') {
    const body = await readBody<Partial<SerializedTimer>>(event)

    if (!body.name) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Bad Request',
        message: 'Timer name is required',
      })
    }

    const now = new Date().toISOString()
    const timer: SerializedTimer = {
      id: `timer_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      name: body.name,
      type: body.type || 'stopwatch',
      is_running: 0,
      paused_time: 0,
      countdown_duration: body.countdown_duration || 0,
      laps: '[]',
      user_id: body.user_id || 'anonymous',
      created_at: now,
      updated_at: now,
    }

    timers.set(timer.id, timer)

    return {
      success: true,
      timer,
    }
  }

  throw createError({
    statusCode: 405,
    statusMessage: 'Method Not Allowed',
  })
})
