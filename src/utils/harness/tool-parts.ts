/**
 * A tool's own part for every harness, without a table of harness names in the tool. Each harness has one module in a
 * folder of the tool, named by its id (`src/ai-spend/lib/drivers/<id>.ts`), that exports the part under one name. The
 * registry is the harness id list (`ACCOUNT_PROVIDER_ALIASES`, the list the drivers are keyed by), so a new harness
 * adds its module to each tool folder and edits no shared file. A module is required on its harness's first use and
 * kept, so a caller that needs one harness loads one module, and an import of the tool loads none.
 *
 * The compiler cannot see a module loaded by name, so `conformance` in each tool's test asks `toolPartsComplete`,
 * which loads every harness's module and fails on a missing one or a wrong export.
 */
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { requireSibling } from "@genesiscz/utils/fs/module-dir";
import type { HarnessId } from "./types";

export interface ToolParts<T> {
    /** The part of one harness, loaded on first use. */
    of(id: HarnessId): T;
    /** Every harness's part, in the canonical harness order. */
    all(): T[];
}

export function toolParts<T>(options: {
    meta: ImportMeta;
    /** The folder beside the caller that holds one module per harness (`"drivers"`, or `"."` for the caller's own). */
    folder: string;
    /** The name every module exports its part under. */
    exportName: string;
    /** Checks the export, so a module with a wrong one fails at its load and not deep in the tool. */
    isPart: (value: unknown) => value is T;
}): ToolParts<T> {
    // Boxed, so a part that is itself null (a harness with no statusline) is still remembered.
    const loaded = new Map<HarnessId, { part: T }>();

    const of = (id: HarnessId): T => {
        const known = loaded.get(id);

        if (known) {
            return known.part;
        }

        const exports: unknown = requireSibling(options.meta, `${options.folder}/${id}`);
        const value: unknown =
            typeof exports === "object" && exports !== null ? Reflect.get(exports, options.exportName) : undefined;

        if (!options.isPart(value)) {
            throw new Error(`${options.folder}/${id} exports no ${options.exportName} of the expected shape`);
        }

        loaded.set(id, { part: value });
        return value;
    };

    return { of, all: () => ACCOUNT_PROVIDER_ALIASES.map(of) };
}

/** Loads every harness's part, so a test fails on a missing module or a wrong export. */
export function toolPartsComplete<T>(parts: ToolParts<T>): T[] {
    return parts.all();
}

/** A guard for a part that is an object with the given members. */
export function hasMembers<T extends object>(
    ...members: readonly (keyof T & string)[]
): (value: unknown) => value is T {
    return (value: unknown): value is T =>
        typeof value === "object" && value !== null && members.every((member) => member in value);
}

/** A guard for a part that is a function. */
export function isFunctionPart<T extends (...args: never[]) => unknown>(value: unknown): value is T {
    return typeof value === "function";
}
