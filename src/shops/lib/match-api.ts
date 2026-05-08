import logger from "@app/logger";
import { getShopsDatabase, type ShopsDatabase } from "../db/ShopsDatabase";
import { MasterMerger } from "./master-merger";

const log = logger.child({ component: "match-api" });

export interface ProductSummary {
    id: number;
    shop_origin: string;
    name: string;
    brand: string | null;
    image_url: string | null;
    unit: string | null;
    unit_amount: number | null;
    flavor_key: string | null;
    ean: string | null;
}

export interface PairDTO {
    productIdA: number;
    productIdB: number;
    similarity: number;
    method: string;
    productA: ProductSummary;
    productB: ProductSummary;
}

export interface MatchApiContext {
    shopsDb?: ShopsDatabase;
}

interface CandidateRow {
    product_id_a: number;
    product_id_b: number;
    similarity: number;
    match_method: string;
    aid: number;
    ashop: string;
    aname: string;
    abrand: string | null;
    aimg: string | null;
    aunit: string | null;
    aamt: number | null;
    aflv: string | null;
    aean: string | null;
    bid: number;
    bshop: string;
    bname: string;
    bbrand: string | null;
    bimg: string | null;
    bunit: string | null;
    bamt: number | null;
    bflv: string | null;
    bean: string | null;
}

export async function listPendingCandidates(ctx: MatchApiContext = {}): Promise<PairDTO[]> {
    const shopsDb = ctx.shopsDb ?? getShopsDatabase();
    const rows = shopsDb
        .raw()
        .query<CandidateRow, []>(
            `SELECT mc.product_id_a, mc.product_id_b, mc.similarity, mc.match_method,
                    pa.id AS aid, pa.shop_origin AS ashop, pa.name AS aname, pa.brand AS abrand, pa.image_url AS aimg, pa.unit AS aunit, pa.unit_amount AS aamt, pa.flavor_key AS aflv, pa.ean AS aean,
                    pb.id AS bid, pb.shop_origin AS bshop, pb.name AS bname, pb.brand AS bbrand, pb.image_url AS bimg, pb.unit AS bunit, pb.unit_amount AS bamt, pb.flavor_key AS bflv, pb.ean AS bean
             FROM match_candidates mc
             JOIN products pa ON pa.id = mc.product_id_a
             JOIN products pb ON pb.id = mc.product_id_b
             WHERE mc.status = 'pending'
             ORDER BY mc.created_at ASC
             LIMIT 200`
        )
        .all();

    return rows.map((r) => ({
        productIdA: r.product_id_a,
        productIdB: r.product_id_b,
        similarity: r.similarity,
        method: r.match_method,
        productA: {
            id: r.aid,
            shop_origin: r.ashop,
            name: r.aname,
            brand: r.abrand,
            image_url: r.aimg,
            unit: r.aunit,
            unit_amount: r.aamt,
            flavor_key: r.aflv,
            ean: r.aean,
        },
        productB: {
            id: r.bid,
            shop_origin: r.bshop,
            name: r.bname,
            brand: r.bbrand,
            image_url: r.bimg,
            unit: r.bunit,
            unit_amount: r.bamt,
            flavor_key: r.bflv,
            ean: r.bean,
        },
    }));
}

export interface PairIdsArgs {
    productIdA: number;
    productIdB: number;
    shopsDb?: ShopsDatabase;
}

export async function acceptCandidatePair(args: PairIdsArgs): Promise<void> {
    const shopsDb = args.shopsDb ?? getShopsDatabase();
    const lo = Math.min(args.productIdA, args.productIdB);
    const hi = Math.max(args.productIdA, args.productIdB);
    const now = new Date().toISOString();

    shopsDb.raw().run(
        `UPDATE match_candidates SET status = 'accepted', reviewed_at = ?, reviewed_by = 'user'
         WHERE product_id_a = ? AND product_id_b = ?`,
        [now, lo, hi]
    );

    const masters = shopsDb
        .raw()
        .query<{ a: number | null; b: number | null }, [number, number]>(
            `SELECT
               (SELECT master_product_id FROM products WHERE id = ?) AS a,
               (SELECT master_product_id FROM products WHERE id = ?) AS b`
        )
        .get(lo, hi);
    if (!masters) {
        log.warn({ lo, hi }, "could not look up master ids for accept");
        return;
    }

    if (masters.a === null && masters.b === null) {
        log.warn({ lo, hi }, "neither product has a master; skipping merge");
        return;
    }

    if (masters.a === null) {
        shopsDb.raw().run(
            `UPDATE products SET master_product_id = ?, match_method = 'user', match_at = ?, last_updated_at = ?
                 WHERE id = ?`,
            [masters.b, now, now, lo]
        );
        return;
    }

    if (masters.b === null) {
        shopsDb.raw().run(
            `UPDATE products SET master_product_id = ?, match_method = 'user', match_at = ?, last_updated_at = ?
                 WHERE id = ?`,
            [masters.a, now, now, hi]
        );
        return;
    }

    if (masters.a === masters.b) {
        return;
    }

    const merger = new MasterMerger(shopsDb);
    const decision = merger.pickSurvivor(masters.a, masters.b);
    await merger.merge(decision);
}

export async function rejectCandidatePair(args: PairIdsArgs): Promise<void> {
    const shopsDb = args.shopsDb ?? getShopsDatabase();
    const lo = Math.min(args.productIdA, args.productIdB);
    const hi = Math.max(args.productIdA, args.productIdB);
    const now = new Date().toISOString();
    const result = shopsDb.raw().run(
        `UPDATE match_candidates SET status = 'rejected', reviewed_at = ?, reviewed_by = 'user'
         WHERE product_id_a = ? AND product_id_b = ?`,
        [now, lo, hi]
    );
    if (result.changes === 0) {
        shopsDb.raw().run(
            `INSERT INTO match_candidates (product_id_a, product_id_b, similarity, match_method, status, created_at, reviewed_at, reviewed_by)
             VALUES (?, ?, 0, 'fuzzy', 'rejected', ?, ?, 'user')`,
            [lo, hi, now, now]
        );
    }
}
