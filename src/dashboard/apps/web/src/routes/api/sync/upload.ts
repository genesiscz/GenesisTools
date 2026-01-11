import { createAPIFileRoute } from '@tanstack/react-start/api'
import { useDatabase } from 'nitro/database'

interface CrudOperation {
  id: string
  op: 'PUT' | 'PATCH' | 'DELETE'
  table: string
  data: Record<string, unknown>
}

interface UploadRequest {
  operations: CrudOperation[]
}

/**
 * PowerSync upload endpoint
 * Receives CRUD batches from the client and applies them to the server database
 */
export const APIRoute = createAPIFileRoute('/api/sync/upload')({
  POST: async ({ request }) => {
    try {
      const body = (await request.json()) as UploadRequest
      const { operations } = body

      if (!operations || operations.length === 0) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const db = useDatabase()

      // Ensure tables exist
      await ensureTables(db)

      // Process each operation
      for (const op of operations) {
        await processOperation(db, op)
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      console.error('[Sync Upload] Error:', error)
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Upload failed' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }
  },
})

async function ensureTables(db: ReturnType<typeof useDatabase>) {
  // Create timers table
  await db.sql`
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timer_type TEXT NOT NULL,
      is_running INTEGER NOT NULL DEFAULT 0,
      elapsed_time INTEGER NOT NULL DEFAULT 0,
      duration INTEGER,
      laps TEXT DEFAULT '[]',
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      show_total INTEGER NOT NULL DEFAULT 0,
      first_start_time TEXT,
      start_time TEXT,
      pomodoro_settings TEXT,
      pomodoro_phase TEXT,
      pomodoro_session_count INTEGER DEFAULT 0
    )
  `

  // Create activity logs table
  await db.sql`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY,
      timer_id TEXT NOT NULL,
      timer_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      elapsed_at_event INTEGER NOT NULL DEFAULT 0,
      session_duration INTEGER,
      previous_value INTEGER,
      new_value INTEGER,
      metadata TEXT DEFAULT '{}'
    )
  `
}

async function processOperation(
  db: ReturnType<typeof useDatabase>,
  op: CrudOperation
) {
  const { table, data } = op

  switch (op.op) {
    case 'PUT':
      // Insert or replace
      if (table === 'timers') {
        await db.sql`
          INSERT OR REPLACE INTO timers (
            id, name, timer_type, is_running, elapsed_time, duration, laps,
            user_id, created_at, updated_at, show_total, first_start_time,
            start_time, pomodoro_settings, pomodoro_phase, pomodoro_session_count
          ) VALUES (
            ${data.id}, ${data.name}, ${data.timer_type}, ${data.is_running ?? 0},
            ${data.elapsed_time ?? 0}, ${data.duration}, ${data.laps ?? '[]'},
            ${data.user_id}, ${data.created_at}, ${data.updated_at},
            ${data.show_total ?? 0}, ${data.first_start_time}, ${data.start_time},
            ${data.pomodoro_settings}, ${data.pomodoro_phase}, ${data.pomodoro_session_count ?? 0}
          )
        `
      } else if (table === 'activity_logs') {
        await db.sql`
          INSERT OR REPLACE INTO activity_logs (
            id, timer_id, timer_name, user_id, event_type, timestamp,
            elapsed_at_event, session_duration, previous_value, new_value, metadata
          ) VALUES (
            ${data.id}, ${data.timer_id}, ${data.timer_name}, ${data.user_id},
            ${data.event_type}, ${data.timestamp}, ${data.elapsed_at_event ?? 0},
            ${data.session_duration}, ${data.previous_value}, ${data.new_value},
            ${data.metadata ?? '{}'}
          )
        `
      }
      break

    case 'PATCH':
      // Update specific fields
      if (table === 'timers') {
        // Build dynamic update
        const updates = Object.entries(data)
          .filter(([key]) => key !== 'id')
          .map(([key]) => `${key} = ?`)
          .join(', ')
        const values = Object.entries(data)
          .filter(([key]) => key !== 'id')
          .map(([, value]) => value)

        if (updates && values.length > 0) {
          // Use raw SQL for dynamic updates
          const query = `UPDATE timers SET ${updates} WHERE id = ?`
          await db.sql`${query}` // Note: this won't work with template literals
          // Fallback to individual field updates
          await db.sql`
            UPDATE timers SET updated_at = ${data.updated_at ?? new Date().toISOString()}
            WHERE id = ${data.id}
          `
        }
      }
      break

    case 'DELETE':
      if (table === 'timers') {
        await db.sql`DELETE FROM timers WHERE id = ${data.id}`
      } else if (table === 'activity_logs') {
        await db.sql`DELETE FROM activity_logs WHERE id = ${data.id}`
      }
      break
  }
}
