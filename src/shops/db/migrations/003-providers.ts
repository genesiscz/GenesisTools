import type { Migration } from "@app/utils/database/migrations";

export const migration003: Migration = {
    id: "003-providers",
    description:
        "Add users, user_providers, user_orders, user_order_items for connecting external shop accounts (rohlik, kosik) and syncing their orders into the local match graph",
    apply(db) {
        db.exec(`
            CREATE TABLE users (
                id            INTEGER PRIMARY KEY,
                email         TEXT NOT NULL UNIQUE,
                password_hash TEXT,
                display_name  TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );

            CREATE TABLE user_providers (
                id                       INTEGER PRIMARY KEY,
                user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                shop_origin              TEXT NOT NULL REFERENCES shops(origin),
                status                   TEXT NOT NULL CHECK (status IN ('connected','expired','error','disconnected')),
                credentials_blob         TEXT,
                external_user_email      TEXT,
                last_sync_at             TEXT,
                last_sync_error          TEXT,
                auto_watchlist           INTEGER NOT NULL DEFAULT 0,
                watchlist_defaults_json  TEXT NOT NULL DEFAULT '{}',
                created_at               TEXT NOT NULL,
                updated_at               TEXT NOT NULL,
                UNIQUE (user_id, shop_origin)
            );
            CREATE INDEX idx_user_providers_user ON user_providers(user_id);

            CREATE TABLE user_orders (
                id                INTEGER PRIMARY KEY,
                user_provider_id  INTEGER NOT NULL REFERENCES user_providers(id) ON DELETE CASCADE,
                external_order_id TEXT NOT NULL,
                ordered_at        TEXT NOT NULL,
                total_amount      REAL NOT NULL,
                currency          TEXT NOT NULL,
                items_count       INTEGER NOT NULL,
                state             TEXT,
                raw_json          TEXT,
                ingested_at       TEXT NOT NULL,
                UNIQUE (user_provider_id, external_order_id)
            );
            CREATE INDEX idx_user_orders_provider_ordered ON user_orders(user_provider_id, ordered_at DESC);

            CREATE TABLE user_order_items (
                order_id            INTEGER NOT NULL REFERENCES user_orders(id) ON DELETE CASCADE,
                line_no             INTEGER NOT NULL,
                external_product_id TEXT,
                name                TEXT NOT NULL,
                quantity            REAL,
                unit                TEXT,
                unit_price          REAL,
                total_price         REAL,
                product_id          INTEGER REFERENCES products(id),
                master_product_id   INTEGER REFERENCES master_products(id),
                matched_at          TEXT,
                PRIMARY KEY (order_id, line_no)
            );
            CREATE INDEX idx_user_order_items_master ON user_order_items(master_product_id) WHERE master_product_id IS NOT NULL;

            INSERT INTO users (id, email, display_name, created_at, updated_at)
            VALUES (1, 'local@local', 'Local', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        `);
    },
};
