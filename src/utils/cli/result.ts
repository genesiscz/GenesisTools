import { SafeJSON } from "@app/utils/json";

/** Canonical machine-result serialization. The ONLY stringifier for stdout
 *  result payloads — used by out.result() and any pre-migration. */
export function asResult(data: unknown): string {
    const s = typeof data === "string" ? data : SafeJSON.stringify(data);
    return s.endsWith("\n") ? s : `${s}\n`;
}
