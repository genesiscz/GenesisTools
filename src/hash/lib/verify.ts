import { algoForHexLength, type HashAlgo, HEX_LENGTH } from "./algorithms";
import { type ChecksumEntry, parseChecksumLines } from "./checksum-file";
import { describeReadError } from "./hash-stream";

export interface VerifyOptions {
    /** The label of the checksum file in messages (`standard input` for `-c -`). */
    label: string;
    /** Set only when the user passed `-a`; otherwise each line's algorithm comes from its tag or its digest length. */
    algo?: HashAlgo;
    quiet: boolean;
    status: boolean;
    strict: boolean;
    warn: boolean;
    ignoreMissing: boolean;
    hashPath: (algo: HashAlgo, path: string) => Promise<string>;
    /** Receives each `<path>: OK` or `<path>: FAILED` line as soon as that file is checked. */
    onLine: (line: string) => void;
    /** Receives per-file read errors, warnings and the closing summary. */
    onMessage: (message: string) => void;
}

export interface VerifyReport {
    exitCode: 0 | 1;
    checked: number;
    ok: number;
}

function resolveAlgo(entry: ChecksumEntry, explicit: HashAlgo | undefined): HashAlgo | undefined {
    if (entry.algo !== undefined) {
        return entry.algo;
    }

    if (explicit !== undefined) {
        return entry.hex.length === HEX_LENGTH[explicit] ? explicit : undefined;
    }

    return algoForHexLength(entry.hex.length);
}

function plural(count: number, singular: string, pluralForm: string): string {
    return count === 1 ? singular : pluralForm;
}

/**
 * Verifies a checksum file with the behavior of `shasum -c`: `<path>: OK` or `<path>: FAILED` per line,
 * `FAILED open or read` for a file that cannot be read, a warning count at the end, and exit code 1 when any file
 * failed, the file has no properly formatted line, or `--strict` met an improper one.
 */
export async function verifyChecksums(text: string, options: VerifyOptions): Promise<VerifyReport> {
    const { onLine, onMessage } = options;
    let failed = false;
    let formatErrors = 0;
    let readErrors = 0;
    let matchErrors = 0;
    let formatOk = 0;
    let ok = 0;

    for (const parsed of parseChecksumLines(text)) {
        const algo = parsed.kind === "entry" ? resolveAlgo(parsed.entry, options.algo) : undefined;
        if (parsed.kind === "improper" || algo === undefined) {
            const line = parsed.kind === "entry" ? parsed.entry.line : parsed.line;
            if (options.warn) {
                onMessage(`hash: ${options.label}: ${line}: improperly formatted checksum line`);
            }

            formatErrors++;
            failed ||= options.strict;
            continue;
        }

        const { entry } = parsed;
        formatOk++;

        let actual: string;
        try {
            actual = await options.hashPath(algo, entry.path);
        } catch (error) {
            const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
            if (missing && options.ignoreMissing) {
                continue;
            }

            onMessage(`hash: ${entry.path}: ${describeReadError(error)}`);
            if (!options.status) {
                onLine(`${entry.path}: FAILED open or read`);
            }

            readErrors++;
            failed = true;
            continue;
        }

        const matches = actual === entry.hex;
        if (matches) {
            ok++;
        } else {
            matchErrors++;
            failed = true;
        }

        if (!options.status && !(options.quiet && matches)) {
            onLine(`${entry.path}: ${matches ? "OK" : "FAILED"}`);
        }
    }

    if (formatOk === 0) {
        onMessage(`hash: ${options.label}: no properly formatted checksum lines found`);
        failed = true;
    } else if (!options.status) {
        if (formatErrors > 0) {
            const verb = plural(formatErrors, "line is", "lines are");
            onMessage(`hash: WARNING: ${formatErrors} ${verb} improperly formatted`);
        }

        if (readErrors > 0) {
            const noun = plural(readErrors, "file", "files");
            onMessage(`hash: WARNING: ${readErrors} listed ${noun} could not be read`);
        }

        if (matchErrors > 0) {
            const noun = plural(matchErrors, "checksum", "checksums");
            onMessage(`hash: WARNING: ${matchErrors} computed ${noun} did NOT match`);
        }
    }

    if (options.ignoreMissing && ok === 0 && formatOk > 0) {
        if (!options.status) {
            onMessage(`hash: ${options.label}: no file was verified`);
        }

        failed = true;
    }

    return { exitCode: failed ? 1 : 0, checked: ok + matchErrors + readErrors, ok };
}
