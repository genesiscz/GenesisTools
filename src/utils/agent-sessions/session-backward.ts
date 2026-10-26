import { logger } from "@genesiscz/utils/logger";
import { resolveHistoryProvider } from "./provider";
import type { BackwardRead, ReadBackwardOptions, TurnBoundary } from "./types";

/**
 * A session's newest entries, from the transcript a hook names (`transcript_path`), through its provider's reader
 * (`NativeSessionReader.readBackward`): the door a hook or a tool uses to read a conversation from its end. `kind` is
 * the harness (`claude`, `codex`, `grok`) or a provider id; the provider finds the session source for the file.
 */
export async function readSessionBackward({
    kind,
    transcriptPath,
    ...options
}: ReadBackwardOptions & { kind: string; transcriptPath: string }): Promise<BackwardRead> {
    const { reader } = resolveHistoryProvider(kind);
    const found = await reader.discover(reader.roots(), { filePaths: [transcriptPath], signal: options.signal });
    const source =
        found.sources.find(
            (candidate) => candidate.filePath === transcriptPath || candidate.dataPaths.includes(transcriptPath)
        ) ?? found.sources[0];

    if (!source) {
        return {
            entries: [],
            found: false,
            issues: [
                ...found.issues,
                { path: transcriptPath, message: `No ${kind} session source for this transcript` },
            ],
        };
    }

    return reader.readBackward(source, options);
}

/** The provider's normalized identity and optional timestamp of the prompt that opened the current turn. */
export async function readSessionTurnBoundary({
    kind,
    transcriptPath,
    ...options
}: Omit<ReadBackwardOptions, "until"> & { kind: string; transcriptPath: string }): Promise<TurnBoundary | null> {
    const { reader } = resolveHistoryProvider(kind);
    const found = await reader.discover(reader.roots(), { filePaths: [transcriptPath], signal: options.signal });
    const source = found.sources.find(
        (candidate) => candidate.filePath === transcriptPath || candidate.dataPaths.includes(transcriptPath)
    );

    for (const issue of found.issues) {
        logger.warn(issue, "Turn boundary discovery issue");
    }

    if (!source) {
        logger.warn({ path: transcriptPath, kind }, "No session source for turn boundary");
        return null;
    }

    return reader.readTurnBoundary(source, options);
}
