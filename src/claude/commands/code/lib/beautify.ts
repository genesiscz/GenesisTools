import { transform } from "esbuild";

/**
 * Pretty-prints a minified bundle via esbuild's printer (no minify = statements one per line).
 * ~4s for a 17MB input. Output is line-diffable but NOT identifier-stable across versions —
 * pair with normalizeIdentifiers for cross-version comparison.
 */
export async function beautify(source: string): Promise<string> {
    const result = await transform(source, { loader: "js", charset: "utf8" });
    return result.code;
}
