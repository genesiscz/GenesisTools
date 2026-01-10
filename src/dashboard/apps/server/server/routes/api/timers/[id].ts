import { eventHandler, readBody, getMethod, createError, getRouterParam } from 'h3'
import type { SerializedTimer } from '@dashboard/shared'

// In-memory store (shared with index.ts - will be refactored to use a proper store)
const timers = new Map<string, SerializedTimer>()

export default eventHandler(async (event) => {
  const method = getMethod(event)
  const id = getRouterParam(event, 'id')

  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Timer ID is required',
    })
  }

  // GET /api/timers/:id - Get a specific timer
  if (method === 'GET') {
    const timer = timers.get(id)

    if (!timer) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Not Found',
        message: `Timer with ID ${id} not found`,
      })
    }

    return { timer }
  }

  // PUT /api/timers/:id - Update a timer
  if (method === 'PUT') {
    const timer = timers.get(id)

    if (!timer) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Not Found',
        message: `Timer with ID ${id} not found`,
      })
    }

    const body = await readBody<Partial<SerializedTimer>>(event)

    const updatedTimer: SerializedTimer = {
      ...timer,
      ...body,
      id, // Ensure ID cannot be changed
      updated_at: new Date().toISOString(),
    }

    timers.set(id, updatedTimer)

    return {
      success: true,
      timer: updatedTimer,
    }
  }

  // DELETE /api/timers/:id - Delete a timer
  if (method === 'DELETE') {
    const existed = timers.delete(id)

    if (!existed) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Not Found',
        message: `Timer with ID ${id} not found`,
      })
    }

    return {
      success: true,
      message: `Timer ${id} deleted`,
    }
  }

  throw createError({
    statusCode: 405,
    statusMessage: 'Method Not Allowed',
  })
})
