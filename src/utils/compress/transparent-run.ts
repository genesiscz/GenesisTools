import { existsSync, lstatSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { recordCompression } from "./ledger";
import {
    type Candidate,
    clonePartner,
    compressOne,
    type Outcome,
    openInodes,
    openPaths,
    resolveStale,
    settle,
    type TransparentWriter,
} from "./transparent";

export interface TransparentRunOptions {
    candidates: Candidate[];
    stale: string[];
    writer: TransparentWriter;
    onBattery?: boolean;
    caller?: string;
    batchBytes?: number;
}

export interface TransparentRunResult {
    skippedBattery: boolean;
    writer: string;
    algorithm: string;
    files: number;
    inputBytes: number;
    outputBytes: number;
    savedBytes: number;
    outcomes: Outcome[];
    recovery: { path: string; status: string }[];
}

/** A failed power-source probe never grants permission to rewrite files. */
export async function batteryPower(): Promise<boolean> {
    const child = Bun.spawn(["/usr/bin/pmset", "-g", "batt"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        if (code !== 0 || !/drawing from '(?:AC|Battery) Power'/.test(stdout)) {
            throw new Error(`Could not establish power source: ${stderr || stdout}`);
        }

        return stdout.includes("'Battery Power'");
    } finally {
        clearTimeout(timer);
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            return false;
        }

        logger.debug({ error, pid }, "could not establish transaction owner exit; preserving scratch");
        return true;
    }
}

function partnerCandidate(path: string): Candidate {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error("partner is not a single-link regular file");
    }

    return { path, size: stat.size, alloc: stat.blocks * 512, ino: stat.ino, mtimeMs: stat.mtimeMs };
}

/** Rewrite only an explicitly supplied plan, with final open-inode settlement for every family member. */
export async function applyTransparent(options: TransparentRunOptions): Promise<TransparentRunResult> {
    const result: TransparentRunResult = {
        skippedBattery: false,
        writer: options.writer.name,
        algorithm: options.writer.algorithm,
        files: 0,
        inputBytes: 0,
        outputBytes: 0,
        savedBytes: 0,
        outcomes: [],
        recovery: [],
    };
    if (!options.onBattery && (await batteryPower())) {
        result.skippedBattery = true;
        return result;
    }

    if (options.stale.length > 0) {
        const held = await openInodes();
        for (const path of options.stale) {
            result.recovery.push({ path, status: await resolveStale(path, alive, held) });
        }
    }

    const heldPaths = options.candidates.length > 0 ? await openPaths() : new Set<string>();
    const candidates = options.candidates.filter((candidate) => !heldPaths.has(candidate.path));
    const seen = new Set<string>();
    const journalTimes = new Map<string, string>();
    for (let at = 0; at < candidates.length; ) {
        const batch: { candidate: Candidate; swaps: Outcome[]; complete: boolean }[] = [];
        let bytes = 0;
        while (
            at < candidates.length &&
            (bytes === 0 || bytes + candidates[at].alloc <= (options.batchBytes ?? 256 * 1024 ** 2))
        ) {
            const candidate = candidates[at++];
            if (seen.has(candidate.path) || !existsSync(candidate.path)) {
                continue;
            }

            seen.add(candidate.path);
            bytes += candidate.alloc;
            const startedAt = new Date().toISOString();
            let original: Outcome;
            try {
                original = await compressOne(candidate, options.writer);
            } catch (error) {
                logger.warn(
                    { error, path: candidate.path },
                    "transparent compression failed; aside retained if present"
                );
                original = {
                    path: candidate.path,
                    status: "failed",
                    before: candidate.alloc,
                    after: candidate.alloc,
                    note: String(error),
                };
            }

            const group = { candidate, swaps: [original], complete: true };
            if (original.status === "compressed") {
                for (const partner of candidate.partners ?? []) {
                    if (seen.has(partner)) {
                        continue;
                    }

                    seen.add(partner);
                    try {
                        if (heldPaths.has(partner)) {
                            throw new Error("clone partner is open");
                        }

                        const outcome = await clonePartner(
                            candidate.path,
                            partnerCandidate(partner),
                            options.writer.algorithm
                        );
                        group.swaps.push(outcome);
                        group.complete &&= outcome.status === "compressed";
                    } catch (error) {
                        group.complete = false;
                        group.swaps.push({ path: partner, status: "failed", before: 0, after: 0, note: String(error) });
                    }
                }
            }

            batch.push(group);
            // The journal is written only after final settlement below.
            journalTimes.set(candidate.path, startedAt);
        }

        if (batch.length === 0) {
            continue;
        }

        // Fail closed. If lsof fails the asides stay for next-start recovery.
        const held = await openInodes();
        for (const group of batch) {
            const outcomes = group.swaps.map((outcome) => settle(outcome, held));
            const successful = outcomes[0].status === "compressed";
            const complete = group.complete && outcomes.every((outcome) => outcome.status === "compressed");
            // Private bytes are measured immediately before each aside unlink. The last old holder
            // releases the shared extent only when no unknown clone still owns it elsewhere.
            const releasedBytes = outcomes.reduce((sum, outcome) => sum + (outcome.releasedBytes ?? 0), 0);
            const saved = successful && complete ? Math.max(0, releasedBytes - outcomes[0].after) : 0;
            result.files += successful ? 1 : 0;
            result.inputBytes += group.candidate.alloc;
            result.outputBytes += successful ? outcomes[0].after : group.candidate.alloc;
            result.savedBytes += saved;
            result.outcomes.push(...outcomes);
            recordCompression({
                op: "compress",
                caller: options.caller ?? "transparent",
                source: group.candidate.path,
                target: group.candidate.path,
                sourceBytes: group.candidate.alloc,
                targetBytes: successful ? outcomes[0].after : group.candidate.alloc,
                ratio: successful ? group.candidate.alloc / Math.max(1, outcomes[0].after) : 1,
                removedOriginal: false,
                files: outcomes.length,
                format: "apfs-decmpfs-1",
                algorithm: options.writer.algorithm,
                writer: options.writer.name,
                releasedBytes,
                savedBytes: saved,
                preset: "transparent",
                startedAt: journalTimes.get(group.candidate.path) ?? new Date().toISOString(),
                endedAt: new Date().toISOString(),
                error: complete
                    ? undefined
                    : outcomes
                          .map((outcome) => outcome.note)
                          .filter(Boolean)
                          .join("; "),
            });
            journalTimes.delete(group.candidate.path);
        }
    }

    return result;
}
