import { SafeJSON } from "@genesiscz/utils/json";

/** Canonical machine-result serialization. The ONLY stringifier for stdout
 *  result payloads — used by out.result() and any pre-migration. */
export function asResult(data: unknown): string {
    // JSON has no `undefined`, so SafeJSON.stringify returns undefined for it
    // (and for functions / symbols). Emitting "null" keeps stdout valid JSON;
    // the old code called .endsWith on that undefined and crashed the process
    // with a Bun stack dump — `chrome-devtools eval '() => location.reload()'`
    // hit it, because page JS that returns nothing is perfectly normal.
    const s = typeof data === "string" ? data : (SafeJSON.stringify(data) ?? "null");

    return s.endsWith("\n") ? s : `${s}\n`;
}
