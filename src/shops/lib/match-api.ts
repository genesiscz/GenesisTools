import logger from "@app/logger";
import { getShopsDatabase, type ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { MasterMerger } from "@app/shops/lib/master-merger";

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

export async function listPendingCandidates(ctx: MatchApiContext = {}): Promise<PairDTO[]> {
    const shopsDb = ctx.shopsDb ?? getShopsDatabase();
    const rows = await shopsDb
        .kysely()
        .selectFrom("match_candidates as mc")
        .innerJoin("products as pa", "pa.id", "mc.product_id_a")
        .innerJoin("products as pb", "pb.id", "mc.product_id_b")
        .select([
            "mc.product_id_a",
            "mc.product_id_b",
            "mc.similarity",
            "mc.match_method",
            "pa.id as aid",
            "pa.shop_origin as ashop",
            "pa.name as aname",
            "pa.brand as abrand",
            "pa.image_url as aimg",
            "pa.unit as aunit",
            "pa.unit_amount as aamt",
            "pa.flavor_key as aflv",
            "pa.ean as aean",
            "pb.id as bid",
            "pb.shop_origin as bshop",
            "pb.name as bname",
            "pb.brand as bbrand",
            "pb.image_url as bimg",
            "pb.unit as bunit",
            "pb.unit_amount as bamt",
            "pb.flavor_key as bflv",
            "pb.ean as bean",
        ])
        .where("mc.status", "=", "pending")
        .orderBy("mc.created_at", "asc")
        .limit(200)
        .execute();

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

    const k = shopsDb.kysely();

    await k
        .updateTable("match_candidates")
        .set({ status: "accepted", reviewed_at: now, reviewed_by: "user" })
        .where("product_id_a", "=", lo)
        .where("product_id_b", "=", hi)
        .execute();

    const aRow = await k.selectFrom("products").select("master_product_id").where("id", "=", lo).executeTakeFirst();
    const bRow = await k.selectFrom("products").select("master_product_id").where("id", "=", hi).executeTakeFirst();
    const a = aRow?.master_product_id ?? null;
    const b = bRow?.master_product_id ?? null;

    if (a === null && b === null) {
        log.warn({ lo, hi }, "neither product has a master; skipping merge");
        return;
    }

    if (a === null) {
        await k
            .updateTable("products")
            .set({ master_product_id: b, match_method: "user", match_at: now, last_updated_at: now })
            .where("id", "=", lo)
            .execute();
        return;
    }

    if (b === null) {
        await k
            .updateTable("products")
            .set({ master_product_id: a, match_method: "user", match_at: now, last_updated_at: now })
            .where("id", "=", hi)
            .execute();
        return;
    }

    if (a === b) {
        return;
    }

    const merger = new MasterMerger(shopsDb);
    const decision = await merger.pickSurvivor(a, b);
    await merger.merge(decision);
}

export async function resolveProductId(shopsDb: ShopsDatabase, input: string): Promise<number> {
    const k = shopsDb.kysely();
    if (/^\d+$/.test(input)) {
        const id = Number(input);
        const row = await k.selectFrom("products").select("id").where("id", "=", id).executeTakeFirst();
        if (!row) {
            throw new Error(`No product with id ${id}`);
        }

        return id;
    }

    const row = await k.selectFrom("products").select("id").where("url", "=", input).executeTakeFirst();
    if (!row) {
        throw new Error(`No product with url ${input}`);
    }

    return row.id;
}

export interface RematchProductArgs {
    shopsDb?: ShopsDatabase;
    productId: number;
}

export async function rematchProduct(args: RematchProductArgs): Promise<void> {
    const shopsDb = args.shopsDb ?? getShopsDatabase();
    const now = new Date().toISOString();
    await shopsDb
        .kysely()
        .updateTable("products")
        .set({ master_product_id: null, match_method: "pending", match_at: now, last_updated_at: now })
        .where("id", "=", args.productId)
        .execute();
    log.info({ productId: args.productId }, "product reset to pending; run a crawl flush to re-match");
}

export async function rejectCandidatePair(args: PairIdsArgs): Promise<void> {
    const shopsDb = args.shopsDb ?? getShopsDatabase();
    const lo = Math.min(args.productIdA, args.productIdB);
    const hi = Math.max(args.productIdA, args.productIdB);
    const now = new Date().toISOString();
    const k = shopsDb.kysely();

    const result = await k
        .updateTable("match_candidates")
        .set({ status: "rejected", reviewed_at: now, reviewed_by: "user" })
        .where("product_id_a", "=", lo)
        .where("product_id_b", "=", hi)
        .executeTakeFirst();

    if (Number(result.numUpdatedRows ?? 0) === 0) {
        await k
            .insertInto("match_candidates")
            .values({
                product_id_a: lo,
                product_id_b: hi,
                similarity: 0,
                match_method: "fuzzy",
                status: "rejected",
                created_at: now,
                reviewed_at: now,
                reviewed_by: "user",
            })
            .execute();
    }
}
