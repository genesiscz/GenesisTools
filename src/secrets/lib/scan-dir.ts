import { readFileSync } from "node:fs";
import { logger } from "@app/logger";
import { scanContent } from "./scan-content";
import { defaultScanConfig, type Finding, type ScanResult, type ScanResultFileSkip } from "./types";
import { walkFiles } from "./walk";

interface ScanDirectoryArgs {
    dir: string;
    respectGitignore: boolean;
    maxSizeKb: number;
    ignorePatterns: RegExp[];
    disableEntropy: boolean;
    /** Injected for deterministic output; the pure core never reads the clock. */
    now: Date;
}

const BINARY_SNIFF_BYTES = 8192;

function looksBinary(buffer: Buffer): boolean {
    const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
    for (let i = 0; i < limit; i++) {
        if (buffer[i] === 0) {
            return true;
        }
    }

    return false;
}

export function scanDirectory(args: ScanDirectoryArgs): ScanResult {
    const config = {
        ...defaultScanConfig(),
        ignorePatterns: args.ignorePatterns,
        disableEntropy: args.disableEntropy,
    };

    const files = walkFiles({
        dir: args.dir,
        respectGitignore: args.respectGitignore,
        maxSizeKb: args.maxSizeKb,
    });

    const findings: Finding[] = [];
    const skips: ScanResultFileSkip[] = [];
    let scannedFiles = 0;

    for (const file of files) {
        let raw: Buffer;

        try {
            raw = readFileSync(file.absPath);
        } catch (err) {
            logger.debug({ err, rel: file.relPath }, "secrets: read failed");
            skips.push({ file: file.relPath, reason: "read-error" });
            continue;
        }

        if (looksBinary(raw)) {
            skips.push({ file: file.relPath, reason: "binary" });
            continue;
        }

        scannedFiles += 1;
        const fileFindings = scanContent({
            content: raw.toString("utf-8"),
            file: file.relPath,
            config,
        });
        findings.push(...fileFindings);
    }

    return {
        scannedFiles,
        skippedFiles: skips.length,
        skips,
        findingCount: findings.length,
        findings,
        scannedAt: args.now.toISOString(),
    };
}
