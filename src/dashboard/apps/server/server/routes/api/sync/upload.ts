import { eventHandler, readBody, createError } from 'h3'

interface CrudOperation {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string
  id: string
  data?: Record<string, unknown>
}

interface CrudBatch {
  crud: CrudOperation[]
}

export default eventHandler(async (event) => {
  try {
    const body = await readBody<CrudBatch>(event)

    if (!body.crud || !Array.isArray(body.crud)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Bad Request',
        message: 'Invalid sync payload: expected { crud: CrudOperation[] }',
      })
    }

    console.log(`[Sync] Received ${body.crud.length} operations`)

    // Process each operation
    const results: { id: string; success: boolean; error?: string }[] = []

    for (const op of body.crud) {
      try {
        // TODO: Apply operations to database
        // For now, just log and acknowledge
        console.log(`[Sync] ${op.op} ${op.type}/${op.id}`)

        results.push({
          id: op.id,
          success: true,
        })
      } catch (error) {
        results.push({
          id: op.id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    const successCount = results.filter(r => r.success).length
    const failureCount = results.filter(r => !r.success).length

    return {
      success: failureCount === 0,
      processed: body.crud.length,
      succeeded: successCount,
      failed: failureCount,
      results,
      timestamp: new Date().toISOString(),
    }
  } catch (error) {
    console.error('[Sync] Upload error:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Sync upload failed',
    })
  }
})
