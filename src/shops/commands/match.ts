import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { getShopsDatabase, type ShopsDatabase } from "../db/ShopsDatabase";
import {
    acceptCandidatePair,
    listPendingCandidates,
    rejectCandidatePair,
} from "../lib/match-api";

const log = logger.child({ component: "tools-shops-match" });

function resolveProductId(shopsDb: ShopsDatabase, input: string): number {
    if (/^\d+$/.test(input)) {
        const id = Number(input);
        const row = shopsDb
            .raw()
            .query<{ id: number }, [number]>("SELECT id FROM products WHERE id = ?")
            .get(id);
        if (!row) {
            throw new Error(`No product with id ${id}`);
        }

        return id;
    }

    const row = shopsDb
        .raw()
        .query<{ id: number }, [string]>("SELECT id FROM products WHERE url = ?")
        .get(input);
    if (!row) {
        throw new Error(`No product with url ${input}`);
    }

    return row.id;
}

export interface PairArgs {
    shopsDb: ShopsDatabase;
    productIdA: number;
    productIdB: number;
}

export async function acceptPair(args: PairArgs): Promise<void> {
    await acceptCandidatePair({
        shopsDb: args.shopsDb,
        productIdA: args.productIdA,
        productIdB: args.productIdB,
    });
}

export async function rejectPair(args: PairArgs): Promise<void> {
    await rejectCandidatePair({
        shopsDb: args.shopsDb,
        productIdA: args.productIdA,
        productIdB: args.productIdB,
    });
}

export async function rematchProduct(args: { shopsDb: ShopsDatabase; productId: number }): Promise<void> {
    const now = new Date().toISOString();
    args.shopsDb
        .raw()
        .run(
            `UPDATE products SET master_product_id = NULL, match_method = 'pending', match_at = ?, last_updated_at = ?
             WHERE id = ?`,
            [now, now, args.productId]
        );
    log.info({ productId: args.productId }, "product reset to pending; run a crawl flush to re-match");
}

export function registerMatchCommand(program: Command): void {
    const cmd = program.command("match").description("Re-match products and triage candidate pairs");

    cmd.command("review")
        .description("List pending gray-zone match candidates as JSON")
        .option("--json", "Output JSON (default)", true)
        .action(async () => {
            const pairs = await listPendingCandidates();
            console.log(SafeJSON.stringify(pairs, null, 2));
        });

    cmd.command("accept <a> <b>")
        .description("Accept a pair (merges masters); a/b are product URLs or ids")
        .action(async (a: string, b: string) => {
            const shopsDb = getShopsDatabase();
            const pa = resolveProductId(shopsDb, a);
            const pb = resolveProductId(shopsDb, b);
            await acceptPair({ shopsDb, productIdA: pa, productIdB: pb });
            console.log(`accepted pair ${pa}-${pb}`);
        });

    cmd.command("reject <a> <b>")
        .description("Reject a pair forever; a/b are product URLs or ids")
        .action(async (a: string, b: string) => {
            const shopsDb = getShopsDatabase();
            const pa = resolveProductId(shopsDb, a);
            const pb = resolveProductId(shopsDb, b);
            await rejectPair({ shopsDb, productIdA: pa, productIdB: pb });
            console.log(`rejected pair ${pa}-${pb}`);
        });

    cmd.command("rematch <input>")
        .description("Reset a product to pending (will re-match on next crawl flush)")
        .action(async (input: string) => {
            const shopsDb = getShopsDatabase();
            const id = resolveProductId(shopsDb, input);
            await rematchProduct({ shopsDb, productId: id });
            console.log(`reset product ${id} to pending`);
        });
}
