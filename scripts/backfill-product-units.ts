#!/usr/bin/env bun
/**
 * One-shot backfill: derive unit/unit_amount/pack_count/flavor_key for existing
 * `products` rows that were ingested before commit 3031bc18 hardcoded `unit:
 * null` in upsertProductPending. Reads each row's `name` (and `metadata_json`
 * for kosik's productQuantity / rohlik's textualAmount when available),
 * computes the four signature fields, and writes them back. Safe to re-run.
 *
 * Usage: bun scripts/backfill-product-units.ts [--dry-run]
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { extractFlavorKey, extractPackCount, extractSize, parseUnit, type Unit } from "../src/shops/lib/normalize";

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = join(homedir(), ".genesis-tools/shops/index.db");

interface Row {
    id: number;
    shop_origin: string;
    name: string;
    unit: string | null;
    unit_amount: number | null;
    pack_count: number | null;
    flavor_key: string | null;
    metadata_json: string;
}

function parseTextualAmount(text: string): { unit: string; amount: number } | undefined {
    const matches = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*([a-zA-Zě]+)/g)];
    const last = matches.at(-1);
    if (!last) {
        return undefined;
    }

    const amount = Number.parseFloat(last[1].replace(",", "."));
    if (Number.isNaN(amount)) {
        return undefined;
    }

    return { unit: last[2].toLowerCase(), amount };
}

function deriveFromMetadata(shopOrigin: string, metaJson: string): { unit?: string; unitAmount?: number } {
    if (!metaJson || metaJson === "{}") {
        return {};
    }

    let meta: Record<string, unknown>;
    try {
        meta = SafeJSON.parse(metaJson) as Record<string, unknown>;
    } catch {
        return {};
    }

    if (shopOrigin === "kosik.cz") {
        const pq = meta.productQuantity as { value?: number; unit?: string } | undefined;
        return { unit: pq?.unit, unitAmount: pq?.value };
    }

    if (shopOrigin === "rohlik.cz") {
        const product = (meta.product as Record<string, unknown> | undefined) ?? meta;
        const textual = product.textualAmount as string | undefined;
        const productUnit = product.unit as string | undefined;
        const fromTextual = textual ? parseTextualAmount(textual) : undefined;
        return {
            unit: fromTextual?.unit ?? productUnit,
            unitAmount: fromTextual?.amount,
        };
    }

    return {};
}

function deriveSignature(row: Row): {
    unit: Unit | null;
    unitAmount: number | null;
    packCount: number | null;
    flavorKey: string | null;
} {
    // Treat (unit, amount) as a coupled tuple — see ShopsDatabase fix.
    // An unrecognised metadata unit (e.g. "praní" from rohlik) must NOT
    // strand the amount on top of a different source.
    const fromMeta = deriveFromMetadata(row.shop_origin, row.metadata_json);
    const metaUnit = fromMeta.unit ? parseUnit(fromMeta.unit) : null;
    const metaSize = metaUnit ? { unit: metaUnit, unitAmount: fromMeta.unitAmount ?? null } : null;
    const fromName = extractSize(row.name);
    const size = metaSize ?? fromName ?? null;
    const unit: Unit | null = size?.unit ?? null;
    const unitAmount = size?.unitAmount ?? null;
    return {
        unit,
        unitAmount,
        packCount: extractPackCount(row.name),
        flavorKey: extractFlavorKey(row.name),
    };
}

function main(): void {
    const db = new Database(DB_PATH);
    const rows = db
        .query<Row, []>(
            `SELECT id, shop_origin, name, unit, unit_amount, pack_count, flavor_key, metadata_json
             FROM products
             WHERE is_active = 1
             ORDER BY id`
        )
        .all();

    let scanned = 0;
    let unitChanged = 0;
    let amountChanged = 0;
    let packChanged = 0;
    let flavorChanged = 0;

    const update = db.prepare(
        `UPDATE products SET unit = ?, unit_amount = ?, pack_count = ?, flavor_key = ? WHERE id = ?`
    );

    db.exec("BEGIN");
    try {
        for (const row of rows) {
            scanned++;
            const sig = deriveSignature(row);

            if (sig.unit !== row.unit) {
                unitChanged++;
            }

            if (sig.unitAmount !== row.unit_amount) {
                amountChanged++;
            }

            if (sig.packCount !== row.pack_count) {
                packChanged++;
            }

            if (sig.flavorKey !== row.flavor_key) {
                flavorChanged++;
            }

            if (!DRY_RUN) {
                update.run(sig.unit, sig.unitAmount, sig.packCount, sig.flavorKey, row.id);
            }
        }

        if (DRY_RUN) {
            db.exec("ROLLBACK");
        } else {
            db.exec("COMMIT");
        }
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }

    console.log(`backfill ${DRY_RUN ? "(DRY-RUN) " : ""}complete:`);
    console.log(`  scanned:        ${scanned}`);
    console.log(`  unit changed:   ${unitChanged}`);
    console.log(`  amount changed: ${amountChanged}`);
    console.log(`  pack changed:   ${packChanged}`);
    console.log(`  flavor changed: ${flavorChanged}`);
}

main();
