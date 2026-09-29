export interface FieldDescriptor {
    uid: string;
    /** The DOM input type: `text`, `password`, `email`, `select-one`, … */
    type: string;
    name: string;
    id: string;
    ariaLabel: string;
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
    node: { name: string };
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
