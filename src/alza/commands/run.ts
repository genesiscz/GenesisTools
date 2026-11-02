import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { openAccountContext } from "../lib/account";
import { findAccountOperation } from "../lib/account-operations";
import { AlzaApi } from "../lib/api";
import { money, moreText, ratingText } from "../lib/format";
import { findOperation, type OperationResult } from "../lib/operations";
import { isStorefrontId, STOREFRONT_IDS, type StorefrontId } from "../lib/storefront";
import type { ListingPage, ProductSummary } from "../lib/types";

export const TOOL = "tools alza";

export interface GlobalOptions {
    country?: string | boolean;
    json?: boolean;
}

export async function resolveStorefront(command: Command): Promise<StorefrontId | null> {
    const opts = command.optsWithGlobals<GlobalOptions>();
    return pickEnumFlag({
        tool: TOOL,
        subcommand: [command.name()],
        flag: "--country",
        given: opts.country,
        values: STOREFRONT_IDS,
        fallback: "cz",
        accepts: isStorefrontId,
    });
}

function isListing(data: unknown): data is ListingPage {
    return typeof data === "object" && data !== null && "items" in data && Array.isArray(data.items);
}

export function renderListingTable(items: ProductSummary[]): string {
    const table = createBoxTable(["CODE", "NAME", "PRICE", "WAS", "-%", "RATING", "STOCK", "BADGE"]);
    for (const item of items) {
        table.push([
            pc.dim(item.code),
            truncateDisplay(item.name, 46),
            pc.bold(money(item.price, item.currency)),
            item.originalPrice ? pc.dim(money(item.originalPrice, item.currency)) : "",
            item.discountPercent ? pc.green(`-${item.discountPercent}`) : "",
            item.rating ? ratingText(item) : pc.dim("—"),
            item.inStock === false
                ? pc.yellow(truncateDisplay(item.availability ?? "no", 14))
                : truncateDisplay(item.availability ?? "", 14),
            truncateDisplay(item.badge ?? "", 22),
        ]);
    }

    return table.toString();
}

/** Runs one operation of the shared table and prints it: `--json` data, a table for listings on a TTY, else markdown. */
export async function runOperation(command: Command, name: string, input: Record<string, unknown>): Promise<void> {
    const storefront = await resolveStorefront(command);
    if (!storefront) {
        return;
    }

    const json = command.optsWithGlobals<GlobalOptions>().json ?? false;
    const api = new AlzaApi({ storefront });
    try {
        const result = await findOperation(name).run(api, input);
        if (json) {
            out.result(result.data);
            return;
        }

        const listing = isListing(result.data) ? result.data : undefined;
        if (listing && process.stdout.isTTY && listing.items.length > 0) {
            out.println(renderListingTable(listing.items));
            out.println(
                pc.dim(
                    `${listing.items.length} shown${listing.total ? ` of ${listing.total}` : ""}${moreText(listing)}`
                )
            );
            return;
        }

        out.println(result.markdown);
    } catch (error) {
        logger.debug({ error, operation: name, input }, "alza command failed");
        out.log.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    } finally {
        await api.close();
    }
}

/**
 * Runs one account operation: the persisted visitor and the stored tokens, `--json` data or markdown. Returns the
 * result (undefined after a printed failure, which also sets exit code 1). A diagnostic never saves the visitor state.
 */
export async function runAccountOperation(
    command: Command,
    name: string,
    input: Record<string, unknown>
): Promise<OperationResult | undefined> {
    const storefront = await resolveStorefront(command);
    if (!storefront) {
        return undefined;
    }

    const json = command.optsWithGlobals<GlobalOptions>().json ?? false;
    const op = findAccountOperation(name);
    const ctx = openAccountContext({ storefront });
    try {
        const result = await op.run(ctx, input);
        if (json) {
            out.result(result.data);
        } else {
            out.println(result.markdown);
        }

        return result;
    } catch (error) {
        logger.debug({ error, operation: name }, "alza account command failed");
        out.log.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return undefined;
    } finally {
        await ctx.close({ save: op.kind !== "diagnostic" });
    }
}

export function parseIntArg(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new InvalidArgumentError(`expected a whole number, got "${value}"`);
    }

    return parsed;
}

export function parseNumberArg(value: string): number {
    const parsed = Number(value.replace(",", "."));
    if (!Number.isFinite(parsed)) {
        throw new InvalidArgumentError(`expected a number, got "${value}"`);
    }

    return parsed;
}
