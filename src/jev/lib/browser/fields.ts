import type { PageNode } from "@app/chrome-devtools/lib/page-snapshot";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { readScriptValue } from "./geometry";
import type { BrowserMcp } from "./session";

const prof = profiler.scope("jev-browser");
const { log } = logger.scoped("jev-browser");

/** One call describes at most this many fields; a page with more is not a form the loop can fill. */
export const MAX_DESCRIBED_FIELDS = 20;

const DESCRIBE_SCRIPT =
    "(...els) => els.map((el) => [el.type || '', el.name || '', el.id || '', el.getAttribute ? (el.getAttribute('aria-label') || '') : ''].join('|')).join('\\n')";

export interface FieldDescriptor {
    uid: string;
    /** The DOM input type: `text`, `password`, `email`, `select-one`, … */
    type: string;
    name: string;
    id: string;
    ariaLabel: string;
}

/**
 * Asks the page what its fillable nodes really are.
 *
 * The accessibility snapshot prints no input type, so a password box and a name box look the same
 * in the text; only the DOM knows. One `evaluate_script` covers every field on the page, which is
 * also where the `name` and `id` attributes for `--inputs` matching come from.
 */
export async function describeFields(options: {
    mcp: BrowserMcp;
    uids: string[];
}): Promise<Map<string, FieldDescriptor>> {
    const uids = options.uids.slice(0, MAX_DESCRIBED_FIELDS);
    const described = new Map<string, FieldDescriptor>();
    if (uids.length === 0) {
        return described;
    }

    try {
        const result = await prof.measureAsync("describe-fields", () =>
            options.mcp.callTool("evaluate_script", { function: DESCRIBE_SCRIPT, args: uids })
        );
        const value = readScriptValue(options.mcp.toolText(result));
        if (typeof value !== "string") {
            log.warn({ uids, value }, "field description script returned no string; falling back to the labels");
            return described;
        }

        const lines = value.split("\n");
        uids.forEach((uid, index) => {
            const parts = (lines[index] ?? "").split("|");
            described.set(uid, {
                uid,
                type: parts[0] ?? "",
                name: parts[1] ?? "",
                id: parts[2] ?? "",
                ariaLabel: parts[3] ?? "",
            });
        });
        log.debug({ fields: described.size }, "described page fields from the DOM");
    } catch (error) {
        log.warn({ error, uids }, "field description failed; falling back to the snapshot labels");
    }

    return described;
}

function normalise(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The `--inputs` value for a field, or undefined. A value NEVER comes from Jev: the loop writes
 * only what the caller supplied, into a field whose DOM name, id, aria-label or accessible name
 * the caller named.
 */
export function inputValueFor(options: {
    node: PageNode;
    field?: FieldDescriptor;
    inputs: Record<string, string>;
}): string | undefined {
    const aliases = new Set(
        [options.node.name, options.field?.name, options.field?.id, options.field?.ariaLabel]
            .filter((alias): alias is string => typeof alias === "string" && alias.length > 0)
            .map(normalise)
    );
    if (aliases.size === 0) {
        return undefined;
    }

    const key = Object.keys(options.inputs).find((name) => aliases.has(normalise(name)));
    return key === undefined ? undefined : options.inputs[key];
}

/** True when the DOM says this field takes a secret, whatever the accessible name reads. */
export function isPasswordField(options: { node: PageNode; field?: FieldDescriptor }): boolean {
    if (options.field) {
        return options.field.type.toLowerCase() === "password";
    }

    return options.node.password === true;
}
