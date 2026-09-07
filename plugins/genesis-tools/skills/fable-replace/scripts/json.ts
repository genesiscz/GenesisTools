/**
 * fable-replace — JSON without the bare global. The repo's lint denies `JSON` so that
 * application code goes through SafeJSON; a standalone plugin script cannot import it,
 * so the two calls live here, once, instead of one ignore per call site.
 */

export const parseJson = (text: string): unknown => {
    // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
    return JSON.parse(text);
};

export const stringifyJson = (value: unknown, indent?: number): string => {
    // biome-ignore lint/style/noRestrictedGlobals: standalone script without access to SafeJSON
    return JSON.stringify(value, null, indent);
};
