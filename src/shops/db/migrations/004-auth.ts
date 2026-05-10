import type { Migration } from "@app/utils/database/migrations";

/**
 * NOTES:
 *  - Each DDL is `db.run` separately, not bundled in `db.exec`. bun:sqlite's
 *    `exec` pre-prepares statements in batch, which fails when a later
 *    statement (e.g. `CREATE INDEX ON favorites(user_id)`) references a column
 *    added by an earlier `ALTER TABLE` in the same exec call.
 *  - The `user_id` columns on `favorites` / `notifications` are deliberately
 *    added WITHOUT a `REFERENCES users(id)` FK clause. SQLite forbids
 *    `ALTER TABLE ADD COLUMN ... REFERENCES ... DEFAULT <non-null>` when
 *    `foreign_keys = ON`, and rebuilding the tables to attach the FK would be
 *    far more invasive than necessary for this single-user-per-row constraint.
 *    Application code (FavoritesRepository, NotificationsRepository) is the
 *    enforcer; the seeded `local@local` user (id=1) absorbs orphaned rows.
 */
export const migration004: Migration = {
    id: "004-auth",
    description: "Add sessions table; add user_id to favorites + notifications (existing rows backfilled to user_id=1)",
    apply(db) {
        db.run(`
            CREATE TABLE sessions (
                token         TEXT PRIMARY KEY,
                user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at    TEXT NOT NULL,
                expires_at    TEXT NOT NULL,
                last_seen_at  TEXT NOT NULL
            )
        `);
        db.run("CREATE INDEX idx_sessions_user ON sessions(user_id)");
        db.run("CREATE INDEX idx_sessions_expires ON sessions(expires_at)");

        db.run("ALTER TABLE favorites ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
        db.run("CREATE INDEX idx_favorites_user ON favorites(user_id)");

        db.run("ALTER TABLE notifications ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
        db.run("CREATE INDEX idx_notifications_user ON notifications(user_id)");
    },
};
