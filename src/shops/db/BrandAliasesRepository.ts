import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { BrandAliasesTable } from "@app/shops/db/types";
import type { Selectable } from "kysely";

export type BrandAlias = Selectable<BrandAliasesTable>;

/**
 * Repository for the `brand_aliases` table. Stores `alias` (lowercased,
 * diacritics-stripped form) → `canonical` mappings used by the matcher to
 * collapse e.g. `Ritter Sport`, `RitterSport`, `RITTER SPORT` into a single
 * canonical brand.
 *
 * ## Shared-canonical handling rules
 *
 * Canonical brands are stored in two distinct shapes; pickers MUST follow
 * these rules at seed time and at user-override time so the matcher does
 * not produce false-merges:
 *
 * 1. **Flat canonical (no namespace)** — used when the brand is sold across
 *    multiple shops as the SAME product family. Examples: `nivea`,
 *    `paralen`, `ibalgin`, `ritter-sport`, `pilsner-urquell`. The matcher
 *    relies on `brand + EAN` to merge cross-shop offers; the flat form is
 *    what makes that merge possible.
 *
 * 2. **Shop-namespaced canonical (`<shop>:<slug>`)** — used ONLY for
 *    private-label / own-brand products that literally do not exist outside
 *    the issuing shop. Examples: `lidl:pilos`, `albert:albert-quality`,
 *    `itesco:tesco-finest`, `dm:balea`, `drmax:dr-max`, `benu:benu`. This
 *    namespacing prevents two different products that happen to share a
 *    brand string (e.g. Lidl's "Pilos" yoghurt vs. Billa's "Pilos" cheese)
 *    from being collapsed into one master.
 *
 * Practical consequences:
 *
 * - Do NOT shop-namespace a brand that any other shop sells (e.g. NEVER
 *   write `drmax:paralen` — Paralen is sold at every CZ pharmacy).
 * - Do NOT flatten a private-label brand whose name happens to also appear
 *   as a substring of a third-party product (`itesco:tesco`, not `tesco`).
 * - When two shops appear to share a private-label name but the products
 *   differ (Lidl `pilos` ≠ Billa `pilos`), keep both shop-namespaced; do
 *   not collapse.
 *
 * The seed-time hand-off document at
 * `.claude/notes/brand-aliases-from-crawlers.md` enumerates the per-shop
 * applications of these rules.
 */
export class BrandAliasesRepository {
    constructor(private readonly db: ShopsDatabase) {}

    private normalizeAlias(alias: string): string {
        return alias.trim().toLowerCase();
    }

    async lookup(alias: string): Promise<string | null> {
        const row = await this.db
            .kysely()
            .selectFrom("brand_aliases")
            .select("canonical")
            .where("alias", "=", this.normalizeAlias(alias))
            .executeTakeFirst();
        return row?.canonical ?? null;
    }

    async upsert(alias: string, canonical: string, source: BrandAlias["source"]): Promise<void> {
        const now = new Date().toISOString();
        await this.db
            .kysely()
            .insertInto("brand_aliases")
            .values({
                alias: this.normalizeAlias(alias),
                canonical,
                source,
                created_at: now,
            })
            .onConflict((oc) =>
                oc.column("alias").doUpdateSet({
                    canonical,
                    source,
                })
            )
            .execute();
    }

    async listAll(): Promise<BrandAlias[]> {
        return await this.db.kysely().selectFrom("brand_aliases").selectAll().execute();
    }

    upsertIfAbsent(args: { alias: string; canonical: string; source: BrandAlias["source"] }): "inserted" | "skipped" {
        const aliasLower = this.normalizeAlias(args.alias);

        const result = this.db
            .raw()
            .query("INSERT OR IGNORE INTO brand_aliases (alias, canonical, source, created_at) VALUES (?, ?, ?, ?)")
            .run(aliasLower, args.canonical, args.source, new Date().toISOString());

        return result.changes > 0 ? "inserted" : "skipped";
    }
}
