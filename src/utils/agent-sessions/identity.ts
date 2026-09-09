import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export interface HistorySourceIdentity {
    providerId: string;
    nativeId: string;
    sourceHome: string;
}

export function historySourceKey(identity: HistorySourceIdentity): string {
    if (!identity.providerId.trim() || !identity.nativeId.trim()) {
        throw new Error("History source identity requires a provider and native ID");
    }

    if (!isAbsolute(identity.sourceHome)) {
        throw new Error("History source home must be absolute");
    }

    const home = realpathSync(identity.sourceHome);
    return SafeJSON.stringify([identity.providerId, home, identity.nativeId]);
}

/** Legacy rows stay addressable until a source read establishes their native identity. */
export function unresolvedHistorySourceKey(options: { providerId: string; filePath: string }): string {
    if (!options.providerId.trim() || !isAbsolute(options.filePath)) {
        throw new Error("Unresolved history identity requires a provider and absolute source path");
    }

    return SafeJSON.stringify(["legacy", options.providerId, "", resolve(options.filePath)]);
}
