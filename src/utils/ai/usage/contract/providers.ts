import { resolveProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { UnknownProviderError } from "@genesiscz/utils/ai/providers/registry";
import { aiUsageCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { UsageQueryError } from "./errors";
import { splitList } from "./selector";

/**
 * `--provider` values as plugin ids, through `resolveProviderAlias` and nothing else, so an
 * alias added to a harness driver works in every usage verb at once. `undefined` means every
 * provider; an unknown name is an error with the name it could not resolve.
 */
export function resolveProviderList(values: string | readonly string[] | boolean | undefined): string[] | undefined {
    if (values === true) {
        throw new UsageQueryError("unknown-provider", "--provider needs a value.");
    }

    const list = splitList(values);

    if (list.length === 0) {
        return undefined;
    }

    const ids: string[] = [];

    for (const value of list) {
        try {
            const id = resolveProviderAlias(value);

            if (!ids.includes(id)) {
                ids.push(id);
            }
        } catch (err) {
            if (err instanceof UnknownProviderError) {
                throw new UsageQueryError("unknown-provider", err.message, { given: value });
            }

            throw err;
        }
    }

    return ids;
}

/**
 * `--harness` picks transcript data (which agent wrote it), an axis only spend has. A limits
 * verb is read per provider, so it refuses the flag rather than ignoring it.
 */
export function refuseHarness(values: string | readonly string[] | boolean | undefined): void {
    if (values === undefined || values === false) {
        return;
    }

    throw new UsageQueryError(
        "reserved",
        `--harness selects transcript data, which ${aiUsageCommand("spend")} reads. Limit windows belong to a provider: use --provider.`
    );
}
