/**
 * TanStack DB Collection for Todos
 *
 * This demonstrates using @tanstack/react-db with PowerSync for:
 * - Offline-first storage via browser SQLite
 * - Reactive queries via useLiveQuery()
 * - Optimistic mutations with automatic rollback
 * - Type-safe schema validation via Zod
 *
 * NOTE: PowerSync is browser-only. The collection is lazily created
 * after initializeDatabase() is called on the client.
 * ALL PowerSync-related imports are dynamic to avoid SSR issues.
 */

import { z } from "zod";

// Zod schema with transforms (SQLite → JS types)
// Input: SQLite types (string, number)
// Output: Rich JS types (boolean, Date)
const todoSchema = z.object({
    id: z.string(),
    text: z.string().nullable(),
    completed: z
        .number()
        .nullable()
        .transform((v) => (v != null ? v === 1 : false)), // SQLite INTEGER → boolean
    user_id: z.string().nullable(),
    created_at: z
        .string()
        .nullable()
        .transform((v) => (v ? new Date(v) : null)), // SQLite TEXT → Date
    updated_at: z
        .string()
        .nullable()
        .transform((v) => (v ? new Date(v) : null)),
});

// Type exports for use in components
export type Todo = z.output<typeof todoSchema>;
export type TodoInput = {
    id: string;
    text: string;
    completed: number; // 0 or 1
    user_id: string;
    created_at: string;
    updated_at: string;
};

// Store the actual collection reference
// biome-ignore lint/suspicious/noExplicitAny: Dynamic collection type from TanStack DB
let _todosCollection: any = null;

/**
 * Get or create the todos collection
 * Must be called after initializeDatabase() on the client
 */
export async function getTodosCollection() {
    if (_todosCollection) {
        return _todosCollection;
    }

    if (typeof window === "undefined") {
        throw new Error("[TodoCollection] Cannot create on server - browser only");
    }

    // Dynamic imports to avoid SSR issues - all PowerSync-related imports happen here
    const [{ createCollection }, { powerSyncCollectionOptions }, { db, APP_SCHEMA }] = await Promise.all([
        import("@tanstack/react-db"),
        import("@tanstack/powersync-db-collection"),
        import("../db/powersync"),
    ]);

    if (!db || !APP_SCHEMA) {
        throw new Error("[TodoCollection] PowerSync not initialized. Call initializeDatabase() first.");
    }

    _todosCollection = createCollection(
        powerSyncCollectionOptions({
            database: db,
            table: APP_SCHEMA.props.todos,
            schema: todoSchema,
            onDeserializationError: (err) => {
                console.error("[LiveSync] Deserialization error:", err);
            },
        })
    );

    console.log("[LiveSync] todosCollection created with shared PowerSync DB");
    return _todosCollection;
}

/**
 * Get the collection synchronously (returns null if not initialized)
 * Use this in components after getTodosCollection() has been called
 */
export function getCollection() {
    return _todosCollection;
}

// Proxy object for backwards compatibility with direct method calls
export const todosCollection = {
    get instance() {
        return _todosCollection;
    },
    insert(data: TodoInput) {
        if (!_todosCollection) {
            throw new Error("Collection not initialized");
        }
        // Convert TodoInput to the format expected by the collection
        return _todosCollection.insert({
            id: data.id,
            text: data.text,
            completed: data.completed === 1,
            user_id: data.user_id,
            created_at: data.created_at ? new Date(data.created_at) : null,
            updated_at: data.updated_at ? new Date(data.updated_at) : null,
        });
    },
    update(id: string, updater: (draft: Todo) => void) {
        if (!_todosCollection) {
            throw new Error("Collection not initialized");
        }
        return _todosCollection.update(id, updater);
    },
    delete(id: string) {
        if (!_todosCollection) {
            throw new Error("Collection not initialized");
        }
        return _todosCollection.delete(id);
    },
};
