import type { Migration } from "@app/utils/database/migrations";

export const migration001: Migration = {
    id: "001-initial",
    description:
        "Create all shops tables (shops, categories, products, master_*, match_candidates, prices, crawl_runs, favorites, notifications, http_requests, brand_aliases) + current_offers view + products_fts FTS5 virtual + sync triggers",
    apply(db) {
        db.exec(`
            -- 1. SHOPS — supported sources (typed capabilities)
            CREATE TABLE shops (
                origin             TEXT PRIMARY KEY,
                display_name       TEXT NOT NULL,
                currency           TEXT NOT NULL,
                cap_live           INTEGER NOT NULL,
                cap_history        INTEGER NOT NULL,
                cap_listing        INTEGER NOT NULL,
                cap_ean            INTEGER NOT NULL,
                cap_search         INTEGER NOT NULL,
                bot_protection     TEXT NOT NULL CHECK (bot_protection IN ('none', 'soft', 'akamai', 'cloudflare')),
                enabled            INTEGER NOT NULL DEFAULT 1,
                last_crawl_at      TEXT,
                homepage_url       TEXT,
                notes              TEXT
            );

            -- 2. CATEGORIES (per-shop) + MASTER_CATEGORIES (canonical)
            CREATE TABLE master_categories (
                id            INTEGER PRIMARY KEY,
                name          TEXT NOT NULL UNIQUE,
                slug          TEXT NOT NULL UNIQUE,
                parent_id     INTEGER REFERENCES master_categories(id),
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE categories (
                id                  TEXT NOT NULL,
                shop_origin         TEXT NOT NULL REFERENCES shops(origin),
                name                TEXT NOT NULL,
                parent_id           TEXT,
                slug                TEXT,
                url                 TEXT,
                product_count       INTEGER,
                master_category_id  INTEGER REFERENCES master_categories(id),
                metadata_json       TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (shop_origin, id)
            );
            CREATE INDEX idx_categories_master ON categories(master_category_id);
            CREATE INDEX idx_categories_parent ON categories(shop_origin, parent_id);

            -- 4. MASTER_PRODUCTS — canonical "master listing"
            CREATE TABLE master_products (
                id                         INTEGER PRIMARY KEY,
                canonical_name             TEXT NOT NULL,
                canonical_name_normalized  TEXT NOT NULL,
                canonical_slug             TEXT NOT NULL UNIQUE,
                brand                      TEXT,
                brand_normalized           TEXT,
                ean                        TEXT,
                master_category_id         INTEGER REFERENCES master_categories(id),
                unit                       TEXT CHECK (unit IS NULL OR unit IN ('g', 'kg', 'ml', 'l', 'ks', 'm', 'm2')),
                unit_amount                REAL,
                pack_count                 INTEGER,
                flavor_key                 TEXT,
                representative_image_url   TEXT,
                total_offers               INTEGER NOT NULL DEFAULT 0,
                best_price                 REAL,
                best_price_shop            TEXT REFERENCES shops(origin),
                best_price_at              TEXT,
                attributes_json            TEXT NOT NULL DEFAULT '{}',
                created_at                 TEXT NOT NULL,
                updated_at                 TEXT NOT NULL,
                verified_by                TEXT CHECK (verified_by IS NULL OR verified_by IN ('auto', 'user'))
            );
            CREATE UNIQUE INDEX idx_master_products_ean       ON master_products(ean) WHERE ean IS NOT NULL;
            CREATE INDEX idx_master_products_brand_normalized ON master_products(brand_normalized);
            CREATE INDEX idx_master_products_category         ON master_products(master_category_id);
            CREATE INDEX idx_master_products_best_price       ON master_products(best_price);
            CREATE INDEX idx_master_products_signature        ON master_products(brand_normalized, unit, unit_amount, flavor_key);

            -- 3. PRODUCTS — per-shop view (master_product_id NULLABLE; NULL only when match_method IN ('gray-zone','pending'))
            CREATE TABLE products (
                id                 INTEGER PRIMARY KEY,
                shop_origin        TEXT NOT NULL REFERENCES shops(origin),
                slug               TEXT NOT NULL,
                url                TEXT NOT NULL,
                name               TEXT NOT NULL,
                name_normalized    TEXT NOT NULL,
                brand              TEXT,
                brand_normalized   TEXT,
                ean                TEXT,
                image_url          TEXT,
                unit               TEXT CHECK (unit IS NULL OR unit IN ('g', 'kg', 'ml', 'l', 'ks', 'm', 'm2')),
                unit_amount        REAL,
                pack_count         INTEGER,
                flavor_key         TEXT,
                master_product_id  INTEGER REFERENCES master_products(id),
                match_method       TEXT NOT NULL CHECK (match_method IN (
                                     'ean', 'fuzzy', 'sig:no-flavor', 'sig:no-size',
                                     'fuzzy-brand-name', 'auto-seed', 'gray-zone',
                                     'pending', 'user', 'llm:haiku'
                                   )),
                match_similarity   REAL,
                match_at           TEXT,
                first_seen_at      TEXT NOT NULL,
                last_updated_at    TEXT NOT NULL,
                is_active          INTEGER NOT NULL DEFAULT 1,
                metadata_json      TEXT NOT NULL DEFAULT '{}',
                UNIQUE (shop_origin, slug)
            );
            CREATE INDEX idx_products_ean              ON products(ean) WHERE ean IS NOT NULL;
            CREATE INDEX idx_products_master_product   ON products(master_product_id);
            CREATE INDEX idx_products_brand_normalized ON products(brand_normalized);
            CREATE INDEX idx_products_name_normalized  ON products(name_normalized);
            CREATE INDEX idx_products_pending          ON products(id) WHERE master_product_id IS NULL;

            CREATE TABLE product_categories (
                product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                category_id TEXT NOT NULL,
                shop_origin TEXT NOT NULL,
                PRIMARY KEY (product_id, category_id, shop_origin),
                FOREIGN KEY (shop_origin, category_id) REFERENCES categories(shop_origin, id)
            );

            -- 5. MATCH_CANDIDATES — pending fuzzy pairs awaiting review
            CREATE TABLE match_candidates (
                product_id_a   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                product_id_b   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                similarity     REAL NOT NULL,
                match_method   TEXT NOT NULL CHECK (match_method IN (
                                 'fuzzy', 'sig:no-flavor', 'sig:no-size',
                                 'fuzzy-brand-name', 'image-phash', 'llm:haiku'
                               )),
                status         TEXT NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'accepted', 'rejected')),
                reviewed_at    TEXT,
                reviewed_by    TEXT CHECK (reviewed_by IS NULL OR reviewed_by IN ('user', 'auto', 'llm:haiku')),
                notes          TEXT,
                created_at     TEXT NOT NULL,
                CHECK (product_id_a < product_id_b),
                PRIMARY KEY (product_id_a, product_id_b)
            );
            CREATE INDEX idx_match_candidates_status ON match_candidates(status);
            CREATE INDEX idx_match_candidates_a      ON match_candidates(product_id_a);
            CREATE INDEX idx_match_candidates_b      ON match_candidates(product_id_b);

            -- 6. PRICES — time series (raw_json kept whenever available)
            CREATE TABLE prices (
                product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                observed_at     TEXT NOT NULL,
                current_price   REAL,
                original_price  REAL,
                in_stock        INTEGER CHECK (in_stock IS NULL OR in_stock IN (0, 1)),
                source          TEXT NOT NULL,
                raw_json        TEXT,
                PRIMARY KEY (product_id, observed_at)
            );
            CREATE INDEX idx_prices_observed         ON prices(observed_at);
            CREATE INDEX idx_prices_product_observed ON prices(product_id, observed_at DESC);

            CREATE VIEW current_offers AS
                SELECT
                    p.id              AS product_id,
                    p.shop_origin,
                    p.master_product_id,
                    p.name,
                    p.url,
                    p.image_url,
                    pr.current_price,
                    pr.original_price,
                    pr.in_stock,
                    pr.observed_at    AS price_observed_at
                FROM products p
                JOIN prices pr ON pr.product_id = p.id
                WHERE p.is_active = 1
                  AND pr.observed_at = (
                      SELECT MAX(observed_at) FROM prices p2 WHERE p2.product_id = p.id
                  );

            -- 7. CRAWL_RUNS — typed CLI options + 'matching'/'cancelled' status
            CREATE TABLE crawl_runs (
                id                  INTEGER PRIMARY KEY,
                shop_origin         TEXT NOT NULL REFERENCES shops(origin),
                strategy            TEXT NOT NULL,
                started_at          TEXT NOT NULL,
                finished_at         TEXT,
                products_seen       INTEGER NOT NULL DEFAULT 0,
                products_new        INTEGER NOT NULL DEFAULT 0,
                prices_recorded     INTEGER NOT NULL DEFAULT 0,
                candidates_added    INTEGER NOT NULL DEFAULT 0,
                status              TEXT NOT NULL DEFAULT 'running'
                                      CHECK (status IN ('running', 'matching', 'completed', 'failed', 'cancelled')),
                error               TEXT,
                option_category_id  TEXT,
                option_limit        INTEGER,
                option_since        TEXT,
                options_json        TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX idx_crawl_runs_shop_started ON crawl_runs(shop_origin, started_at DESC);

            -- 8. FAVORITES — master_product_id NOT NULL + optional restricted_to_shop
            CREATE TABLE favorites (
                id                   INTEGER PRIMARY KEY,
                master_product_id    INTEGER NOT NULL REFERENCES master_products(id) ON DELETE CASCADE,
                restricted_to_shop   TEXT REFERENCES shops(origin),
                label                TEXT,
                target_price         REAL,
                drop_percent         REAL,
                drop_absolute        REAL,
                reference_price      REAL,
                notify_back_in_stock INTEGER NOT NULL DEFAULT 0,
                cooldown_hours       INTEGER NOT NULL DEFAULT 24,
                active               INTEGER NOT NULL DEFAULT 1,
                created_at           TEXT NOT NULL,
                UNIQUE (master_product_id, restricted_to_shop)
            );
            CREATE INDEX idx_favorites_master_product ON favorites(master_product_id);
            CREATE INDEX idx_favorites_active         ON favorites(active) WHERE active = 1;

            -- 9. NOTIFICATIONS — typed delivery columns + reason CHECK
            CREATE TABLE notifications (
                id                    INTEGER PRIMARY KEY,
                favorite_id           INTEGER NOT NULL REFERENCES favorites(id) ON DELETE CASCADE,
                master_product_id     INTEGER NOT NULL REFERENCES master_products(id),
                product_id            INTEGER REFERENCES products(id),
                fired_at              TEXT NOT NULL,
                reason                TEXT NOT NULL CHECK (reason IN (
                                        'target-price', 'drop-percent', 'drop-absolute', 'back-in-stock'
                                      )),
                prev_price            REAL,
                curr_price            REAL,
                shop_origin           TEXT REFERENCES shops(origin),
                delivered_macos_at    TEXT,
                delivered_web_at      TEXT,
                delivered_telegram_at TEXT,
                delivery_error        TEXT,
                acknowledged_at       TEXT,
                metadata_json         TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX idx_notifications_fired    ON notifications(fired_at DESC);
            CREATE INDEX idx_notifications_unack    ON notifications(acknowledged_at) WHERE acknowledged_at IS NULL;
            CREATE INDEX idx_notifications_favorite ON notifications(favorite_id);

            -- 10. HTTP_REQUESTS — typed correlation columns + method CHECK
            CREATE TABLE http_requests (
                id                INTEGER PRIMARY KEY,
                ts                TEXT NOT NULL,
                method            TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
                url               TEXT NOT NULL,
                shop_origin       TEXT REFERENCES shops(origin),
                source            TEXT NOT NULL,
                operation         TEXT,
                status            INTEGER,
                duration_ms       INTEGER NOT NULL,
                request_bytes     INTEGER,
                response_bytes    INTEGER,
                request_id        TEXT,
                crawl_run_id      INTEGER REFERENCES crawl_runs(id) ON DELETE SET NULL,
                product_slug      TEXT,
                master_product_id INTEGER REFERENCES master_products(id) ON DELETE SET NULL,
                category_id       TEXT,
                error             TEXT,
                request_excerpt   TEXT,
                response_excerpt  TEXT,
                context_json      TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX idx_http_requests_ts             ON http_requests(ts DESC);
            CREATE INDEX idx_http_requests_shop_ts        ON http_requests(shop_origin, ts DESC) WHERE shop_origin IS NOT NULL;
            CREATE INDEX idx_http_requests_errors         ON http_requests(ts DESC) WHERE status IS NULL OR status >= 400;
            CREATE INDEX idx_http_requests_source_ts      ON http_requests(source, ts DESC);
            CREATE INDEX idx_http_requests_crawl_run      ON http_requests(crawl_run_id) WHERE crawl_run_id IS NOT NULL;
            CREATE INDEX idx_http_requests_master_product ON http_requests(master_product_id) WHERE master_product_id IS NOT NULL;

            -- 11. BRAND_ALIASES — canonical brand normalization (Plan 04 seeds; Plan 01 creates the table)
            CREATE TABLE brand_aliases (
                alias       TEXT PRIMARY KEY,
                canonical   TEXT NOT NULL,
                source      TEXT NOT NULL CHECK (source IN ('seed', 'user', 'auto')),
                created_at  TEXT NOT NULL
            );
            CREATE INDEX idx_brand_aliases_canonical ON brand_aliases(canonical);

            -- 12. PRODUCTS_FTS — FTS5 full-text search over products with diacritic-insensitive tokenizer.
            CREATE VIRTUAL TABLE products_fts USING fts5(
                name, name_normalized, brand, brand_normalized, category_path,
                content='products', content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            );

            CREATE TRIGGER products_ai AFTER INSERT ON products BEGIN
                INSERT INTO products_fts(rowid, name, name_normalized, brand, brand_normalized, category_path)
                VALUES (new.id, new.name, new.name_normalized, new.brand, new.brand_normalized,
                        (SELECT json_group_array(c.name) FROM product_categories pc
                         JOIN categories c ON c.shop_origin = pc.shop_origin AND c.id = pc.category_id
                         WHERE pc.product_id = new.id));
            END;

            CREATE TRIGGER products_ad AFTER DELETE ON products BEGIN
                INSERT INTO products_fts(products_fts, rowid, name, name_normalized, brand, brand_normalized, category_path)
                VALUES ('delete', old.id, old.name, old.name_normalized, old.brand, old.brand_normalized, NULL);
            END;

            CREATE TRIGGER products_au AFTER UPDATE ON products BEGIN
                INSERT INTO products_fts(products_fts, rowid, name, name_normalized, brand, brand_normalized, category_path)
                VALUES ('delete', old.id, old.name, old.name_normalized, old.brand, old.brand_normalized, NULL);
                INSERT INTO products_fts(rowid, name, name_normalized, brand, brand_normalized, category_path)
                VALUES (new.id, new.name, new.name_normalized, new.brand, new.brand_normalized,
                        (SELECT json_group_array(c.name) FROM product_categories pc
                         JOIN categories c ON c.shop_origin = pc.shop_origin AND c.id = pc.category_id
                         WHERE pc.product_id = new.id));
            END;
        `);
    },
};
