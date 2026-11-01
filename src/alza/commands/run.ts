import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import { type Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { AlzaApi } from "../lib/api";
import { money, ratingText } from "../lib/format";
import { findOperation } from "../lib/operations";
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
                    `${listing.items.length} shown${listing.total ? ` of ${listing.total}` : ""}${listing.hasMore ? ", more pages exist" : ""}`
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
