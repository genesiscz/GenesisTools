/**
 * Unified Server Functions for Todos with Backend Switch
 *
 * Demonstrates two different database backends:
 * 1. Neon Raw - Direct SQL queries to Neon PostgreSQL
 * 2. Drizzle + Neon - Type-safe ORM queries to Neon PostgreSQL
 *
 * Note: Nitro SQLite was removed because nitro/database uses virtual modules
 * that aren't available during TanStack Start's SSR process.
 *
 * The backend can be switched at runtime via the `backend` parameter
 * or configured via TODO_DB_BACKEND environment variable.
 */

import { neon } from "@neondatabase/serverless";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { todos } from "./drizzle/schema";

// Backend types (nitro-sqlite removed due to SSR incompatibility)
export type DbBackend = "neon-raw" | "drizzle-neon";

// Get the configured backend from env or default
const getBackend = (): DbBackend => {
    const env = process.env.TODO_DB_BACKEND as DbBackend;
    if (env === "neon-raw" || env === "drizzle-neon") {
        return env;
    }
    return "drizzle-neon";
};

// ============================================
// Database Row Type (matches schema)
// ============================================

interface TodoRow {
    id: string;
    text: string;
    completed: number;
    user_id: string;
    created_at: string;
    updated_at: string;
}

// ============================================
// A. Neon Raw SQL Adapter
// Direct SQL queries to Neon PostgreSQL
// ============================================

const neonAdapter = {
    sql: null as ReturnType<typeof neon> | null,

    getClient() {
        if (!this.sql) {
            const url = process.env.DATABASE_URL;
            if (!url) {
                throw new Error("DATABASE_URL environment variable is required for Neon");
            }
            this.sql = neon(url);
        }
        return this.sql;
    },

    async ensureTable() {
        const sql = this.getClient();
        try {
            // Try to select from table to check schema
            await sql`SELECT id, text, completed, user_id, created_at, updated_at FROM todos LIMIT 1`;
            console.log("[Server:Neon] Table exists with correct schema");
        } catch {
            // Schema mismatch or table doesn't exist - recreate
            console.log("[Server:Neon] Recreating table due to schema mismatch");
            await sql`DROP TABLE IF EXISTS todos`;
            await sql`
                CREATE TABLE todos (
                    id TEXT PRIMARY KEY,
                    text TEXT NOT NULL,
                    completed INTEGER NOT NULL DEFAULT 0,
                    user_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            `;
            console.log("[Server:Neon] Table recreated");
        }
    },

    async getAll(userId: string) {
        const sql = this.getClient();
        const rows = (await sql`
      SELECT * FROM todos WHERE user_id = ${userId} ORDER BY created_at DESC
    `) as unknown as TodoRow[];
        console.log("[Server:Neon] Fetched", rows.length, "todos");
        return rows;
    },

    async upsert(todo: TodoRow) {
        const sql = this.getClient();
        await sql`
      INSERT INTO todos (id, text, completed, user_id, created_at, updated_at)
      VALUES (${todo.id}, ${todo.text}, ${todo.completed}, ${todo.user_id}, ${todo.created_at}, ${todo.updated_at})
      ON CONFLICT (id) DO UPDATE SET
        text = EXCLUDED.text,
        completed = EXCLUDED.completed,
        updated_at = EXCLUDED.updated_at
    `;
        console.log("[Server:Neon] Upserted todo:", todo.id);
    },

    async delete(id: string) {
        const sql = this.getClient();
        await sql`DELETE FROM todos WHERE id = ${id}`;
        console.log("[Server:Neon] Deleted todo:", id);
    },
};

// ============================================
// B. Drizzle + Neon Adapter (TYPE-SAFE!)
// Uses Drizzle ORM for type-safe queries
// ============================================

const drizzleAdapter = {
    db: null as ReturnType<typeof drizzle> | null,

    getClient() {
        if (!this.db) {
            const url = process.env.DATABASE_URL;
            if (!url) {
                throw new Error("DATABASE_URL environment variable is required for Drizzle");
            }
            this.db = drizzle(neon(url));
        }
        return this.db;
    },

    async ensureTable() {
        // Drizzle typically uses migrations, but for demo we'll create inline
        const sql = neon(process.env.DATABASE_URL!);
        try {
            // Try to select from table to check schema
            await sql`SELECT id, text, completed, user_id, created_at, updated_at FROM todos LIMIT 1`;
            console.log("[Server:Drizzle] Table exists with correct schema");
        } catch {
            // Schema mismatch or table doesn't exist - recreate
            console.log("[Server:Drizzle] Recreating table due to schema mismatch");
            await sql`DROP TABLE IF EXISTS todos`;
            await sql`
                CREATE TABLE todos (
                    id TEXT PRIMARY KEY,
                    text TEXT NOT NULL,
                    completed INTEGER NOT NULL DEFAULT 0,
                    user_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            `;
            console.log("[Server:Drizzle] Table recreated");
        }
    },

    async getAll(userId: string) {
        const db = this.getClient();
        const rows = await db.select().from(todos).where(eq(todos.userId, userId)).orderBy(todos.createdAt);
        console.log("[Server:Drizzle] Fetched", rows.length, "todos");
        // Convert to TodoRow format for consistency
        return rows.map((r) => ({
            id: r.id,
            text: r.text,
            completed: r.completed,
            user_id: r.userId,
            created_at: r.createdAt,
            updated_at: r.updatedAt,
        }));
    },

    async upsert(todo: TodoRow) {
        const db = this.getClient();
        try {
            await db
                .insert(todos)
                .values({
                    id: todo.id,
                    text: todo.text,
                    completed: todo.completed,
                    userId: todo.user_id,
                    createdAt: todo.created_at,
                    updatedAt: todo.updated_at,
                })
                .onConflictDoUpdate({
                    target: todos.id,
                    set: {
                        text: todo.text,
                        completed: todo.completed,
                        updatedAt: todo.updated_at,
                    },
                });
            console.log("[Server:Drizzle] Upserted todo:", todo.id);
        } catch (err) {
            console.error("[Server:Drizzle] Upsert failed:", err);
            // Fall back to raw SQL if Drizzle fails
            const sql = neon(process.env.DATABASE_URL!);
            await sql`
                INSERT INTO todos (id, text, completed, user_id, created_at, updated_at)
                VALUES (${todo.id}, ${todo.text}, ${todo.completed}, ${todo.user_id}, ${todo.created_at}, ${todo.updated_at})
                ON CONFLICT (id) DO UPDATE SET
                    text = EXCLUDED.text,
                    completed = EXCLUDED.completed,
                    updated_at = EXCLUDED.updated_at
            `;
            console.log("[Server:Drizzle] Fallback SQL upsert succeeded:", todo.id);
        }
    },

    async delete(id: string) {
        const db = this.getClient();
        await db.delete(todos).where(eq(todos.id, id));
        console.log("[Server:Drizzle] Deleted todo:", id);
    },
};

// ============================================
// Adapter Selection
// ============================================

type Adapter = typeof neonAdapter | typeof drizzleAdapter;

const getAdapter = (backend?: DbBackend): Adapter => {
    const b = backend ?? getBackend();
    console.log("[Server] Using backend:", b);
    switch (b) {
        case "neon-raw":
            return neonAdapter;
        case "drizzle-neon":
            return drizzleAdapter;
        default:
            return drizzleAdapter;
    }
};

// ============================================
// Server Functions (backend-agnostic)
// ============================================

/**
 * Get all todos for a user
 */
export const getTodos = createServerFn({ method: "GET" })
    .inputValidator((d: { userId: string; backend?: DbBackend }) => d)
    .handler(async ({ data }): Promise<TodoRow[]> => {
        console.log("[Server] getTodos called:", data);
        const adapter = getAdapter(data.backend);
        await adapter.ensureTable();
        return adapter.getAll(data.userId);
    });

/**
 * CRUD Operation from PowerSync connector
 */
interface CrudOperation {
    id: string;
    op: "PUT" | "PATCH" | "DELETE";
    table: string;
    data: Record<string, unknown>;
}

/**
 * Upload CRUD batch from PowerSync to server database
 * This is called by the PowerSync connector when syncing
 */
export const uploadTodoBatch = createServerFn({ method: "POST" })
    .inputValidator((d: { operations: CrudOperation[]; backend?: DbBackend }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        console.log("[Server] uploadTodoBatch called with", data.operations.length, "operations");
        const adapter = getAdapter(data.backend);
        await adapter.ensureTable();

        for (const op of data.operations) {
            if (op.table !== "todos") {
                console.log("[Server] Skipping non-todos operation:", op.table);
                continue;
            }

            switch (op.op) {
                case "PUT":
                case "PATCH":
                    await adapter.upsert(op.data as unknown as TodoRow);
                    break;
                case "DELETE":
                    await adapter.delete(op.data.id as string);
                    break;
            }
        }

        console.log("[Server] Processed", data.operations.length, "operations");
        return { success: true };
    });

/**
 * Create a single todo directly (for WebSocket-only mode)
 */
export const createTodo = createServerFn({ method: "POST" })
    .inputValidator((d: { todo: TodoRow; backend?: DbBackend }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        console.log("[Server] createTodo called:", data.todo.id);
        const adapter = getAdapter(data.backend);
        await adapter.ensureTable();
        await adapter.upsert(data.todo);
        return { success: true };
    });

/**
 * Delete a single todo directly
 */
export const deleteTodoFromServer = createServerFn({ method: "POST" })
    .inputValidator((d: { id: string; backend?: DbBackend }) => d)
    .handler(async ({ data }): Promise<{ success: boolean }> => {
        console.log("[Server] deleteTodo called:", data.id);
        const adapter = getAdapter(data.backend);
        await adapter.ensureTable();
        await adapter.delete(data.id);
        return { success: true };
    });
