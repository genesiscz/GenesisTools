/**
 * Drizzle ORM Schema for Todos
 *
 * This provides type-safe database operations when using Drizzle + Neon.
 * The schema matches the PowerSync SQLite schema for consistency.
 */

import { pgTable, text, integer } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
    id: text("id").primaryKey(),
    text: text("text").notNull(),
    completed: integer("completed").notNull().default(0),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});

// Type exports for type-safe operations
export type TodoRecord = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;
