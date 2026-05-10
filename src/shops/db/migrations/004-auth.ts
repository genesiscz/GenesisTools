import type { Migration } from "@app/utils/database/migrations";

export const migration004: Migration = {
    id: "004-auth",
    description: "Add sessions table; add user_id to favorites + notifications (existing rows backfilled to user_id=1)",
    apply(db) {
        db.exec(`
            CREATE TABLE sessions (
                token         TEXT PRIMARY KEY,
                user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at    TEXT NOT NULL,
                expires_at    TEXT NOT NULL,
                last_seen_at  TEXT NOT NULL
            );
            CREATE INDEX idx_sessions_user ON sessions(user_id);
            CREATE INDEX idx_sessions_expires ON sessions(expires_at);

            ALTER TABLE favorites ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
            CREATE INDEX idx_favorites_user ON favorites(user_id);

            ALTER TABLE notifications ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE;
            CREATE INDEX idx_notifications_user ON notifications(user_id);
        `);
    },
};
