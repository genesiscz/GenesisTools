import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/** The fields of a parsed JSON object; undefined for null, an array or a scalar. */
export function objectFields(value: unknown): Record<string, unknown> | undefined {
    return isObject(value) ? value : undefined;
}

/**
 * Reads a JSON file GenesisTools.app wrote beside a screenshot and narrows it with `parse`. Undefined when the file is missing
 * (a screenshot from another tool) or `parse` rejects its shape, which is logged as `warning`.
 */
export async function readJsonSidecar<T>({
    path,
    parse,
    warning,
}: {
    path: string;
    parse: (value: unknown) => T | undefined;
    warning: string;
}): Promise<T | undefined> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return undefined;
    }

    const parsed = parse(SafeJSON.parse(await file.text(), { strict: true }));
    if (!parsed) {
        logger.warn({ path }, warning);
    }

    return parsed;
}
