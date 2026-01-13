/**
 * Drizzle ORM Tests
 *
 * Tests for type-safe database operations with Drizzle
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db, timers, activityLogs, type Timer, type ActivityLog } from '@/drizzle'
import { eq, desc } from 'drizzle-orm'

describe('Drizzle ORM - Timers', () => {
  const testUserId = `test-user-${Date.now()}`
  const testTimerId = `timer-${Date.now()}`

  afterAll(async () => {
    // Cleanup test data
    await db.delete(timers).where(eq(timers.userId, testUserId))
    await db.delete(activityLogs).where(eq(activityLogs.userId, testUserId))
  })

  test('insert timer', async () => {
    const newTimer = {
      id: testTimerId,
      name: 'Test Timer',
      timerType: 'stopwatch' as const,
      isRunning: 0,
      elapsedTime: 0,
      duration: null,
      laps: [],
      userId: testUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      showTotal: 1,
      firstStartTime: null,
      startTime: null,
      pomodoroSettings: null,
      pomodoroPhase: null,
      pomodoroSessionCount: 0,
    }

    await db.insert(timers).values(newTimer)

    const result = await db.select()
      .from(timers)
      .where(eq(timers.id, testTimerId))

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Test Timer')
    expect(result[0].timerType).toBe('stopwatch')
    expect(result[0].userId).toBe(testUserId)
  })

  test('select timer by user ID', async () => {
    const results = await db.select()
      .from(timers)
      .where(eq(timers.userId, testUserId))
      .orderBy(desc(timers.createdAt))

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].id).toBe(testTimerId)
  })

  test('update timer', async () => {
    await db.update(timers)
      .set({
        name: 'Updated Timer',
        elapsedTime: 5000,
        updatedAt: new Date().toISOString()
      })
      .where(eq(timers.id, testTimerId))

    const result = await db.select()
      .from(timers)
      .where(eq(timers.id, testTimerId))

    expect(result[0].name).toBe('Updated Timer')
    expect(result[0].elapsedTime).toBe(5000)
  })

  test('upsert timer (insert on conflict)', async () => {
    const timerId = `timer-upsert-${Date.now()}`
    const initialTimer = {
      id: timerId,
      name: 'Initial Name',
      timerType: 'countdown' as const,
      isRunning: 0,
      elapsedTime: 0,
      duration: 60000,
      laps: [],
      userId: testUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      showTotal: 0,
      firstStartTime: null,
      startTime: null,
      pomodoroSettings: null,
      pomodoroPhase: null,
      pomodoroSessionCount: 0,
    }

    // First insert
    await db.insert(timers).values(initialTimer)

    // Upsert (update on conflict)
    await db.insert(timers)
      .values({ ...initialTimer, name: 'Updated Name', elapsedTime: 10000 })
      .onConflictDoUpdate({
        target: timers.id,
        set: {
          name: 'Updated Name',
          elapsedTime: 10000,
          updatedAt: new Date().toISOString()
        }
      })

    const result = await db.select()
      .from(timers)
      .where(eq(timers.id, timerId))

    expect(result[0].name).toBe('Updated Name')
    expect(result[0].elapsedTime).toBe(10000)

    // Cleanup
    await db.delete(timers).where(eq(timers.id, timerId))
  })

  test('delete timer', async () => {
    const timerId = `timer-delete-${Date.now()}`

    await db.insert(timers).values({
      id: timerId,
      name: 'To Delete',
      timerType: 'stopwatch' as const,
      isRunning: 0,
      elapsedTime: 0,
      duration: null,
      laps: [],
      userId: testUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      showTotal: 0,
      firstStartTime: null,
      startTime: null,
      pomodoroSettings: null,
      pomodoroPhase: null,
      pomodoroSessionCount: 0,
    })

    await db.delete(timers).where(eq(timers.id, timerId))

    const result = await db.select()
      .from(timers)
      .where(eq(timers.id, timerId))

    expect(result).toHaveLength(0)
  })

  test('timer with JSON fields (laps)', async () => {
    const timerId = `timer-laps-${Date.now()}`
    const lapsData = [
      { number: 1, lapTime: 1000, splitTime: 1000, timestamp: new Date().toISOString() },
      { number: 2, lapTime: 1500, splitTime: 2500, timestamp: new Date().toISOString() },
    ]

    await db.insert(timers).values({
      id: timerId,
      name: 'Lap Timer',
      timerType: 'stopwatch' as const,
      isRunning: 0,
      elapsedTime: 2500,
      duration: null,
      laps: lapsData,
      userId: testUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      showTotal: 0,
      firstStartTime: null,
      startTime: null,
      pomodoroSettings: null,
      pomodoroPhase: null,
      pomodoroSessionCount: 0,
    })

    const result = await db.select()
      .from(timers)
      .where(eq(timers.id, timerId))

    expect(result[0].laps).toEqual(lapsData)

    // Cleanup
    await db.delete(timers).where(eq(timers.id, timerId))
  })

  test('timer with pomodoro settings', async () => {
    const timerId = `timer-pomodoro-${Date.now()}`
    const pomodoroSettings = {
      workDuration: 25 * 60 * 1000,
      shortBreakDuration: 5 * 60 * 1000,
      longBreakDuration: 15 * 60 * 1000,
      sessionsBeforeLongBreak: 4,
    }

    await db.insert(timers).values({
      id: timerId,
      name: 'Pomodoro Timer',
      timerType: 'pomodoro' as const,
      isRunning: 0,
      elapsedTime: 0,
      duration: 25 * 60 * 1000,
      laps: [],
      userId: testUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      showTotal: 0,
      firstStartTime: null,
      startTime: null,
      pomodoroSettings: pomodoroSettings,
      pomodoroPhase: 'work',
      pomodoroSessionCount: 1,
    })

    const result = await db.select()
      .from(timers)
      .where(eq(timers.id, timerId))

    expect(result[0].pomodoroSettings).toEqual(pomodoroSettings)
    expect(result[0].pomodoroPhase).toBe('work')
    expect(result[0].pomodoroSessionCount).toBe(1)

    // Cleanup
    await db.delete(timers).where(eq(timers.id, timerId))
  })
})

describe('Drizzle ORM - Activity Logs', () => {
  const testUserId = `test-user-logs-${Date.now()}`
  const testTimerId = `timer-logs-${Date.now()}`

  afterAll(async () => {
    // Cleanup
    await db.delete(activityLogs).where(eq(activityLogs.userId, testUserId))
  })

  test('insert activity log', async () => {
    const logId = `log-${Date.now()}`

    await db.insert(activityLogs).values({
      id: logId,
      timerId: testTimerId,
      timerName: 'Test Timer',
      userId: testUserId,
      eventType: 'start',
      timestamp: new Date().toISOString(),
      elapsedAtEvent: 0,
      sessionDuration: null,
      previousValue: null,
      newValue: null,
      metadata: {},
    })

    const result = await db.select()
      .from(activityLogs)
      .where(eq(activityLogs.id, logId))

    expect(result).toHaveLength(1)
    expect(result[0].eventType).toBe('start')
    expect(result[0].timerId).toBe(testTimerId)
  })

  test('insert activity log with metadata', async () => {
    const logId = `log-meta-${Date.now()}`
    const metadata = { notes: 'Important session', tags: ['work', 'project-x'] }

    await db.insert(activityLogs).values({
      id: logId,
      timerId: testTimerId,
      timerName: 'Test Timer',
      userId: testUserId,
      eventType: 'pause',
      timestamp: new Date().toISOString(),
      elapsedAtEvent: 5000,
      sessionDuration: 5000,
      previousValue: null,
      newValue: null,
      metadata: metadata,
    })

    const result = await db.select()
      .from(activityLogs)
      .where(eq(activityLogs.id, logId))

    expect(result[0].metadata).toEqual(metadata)
    expect(result[0].sessionDuration).toBe(5000)
  })

  test('query activity logs by user', async () => {
    const results = await db.select()
      .from(activityLogs)
      .where(eq(activityLogs.userId, testUserId))
      .orderBy(desc(activityLogs.timestamp))

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].userId).toBe(testUserId)
  })
})
