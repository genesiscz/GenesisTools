// Re-export the canonical helper so existing `@app/task/lib/process-alive`
// imports keep working — the implementation lives in src/utils/process-alive.ts
// (one copy across timer, port, task, storage/file-lock, DashboardApp).
export { isProcessAlive } from "@app/utils/process-alive";
