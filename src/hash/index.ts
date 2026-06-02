import { logger, out } from "@app/logger";
import { isInteractive, runTool, suggestCommand } from "@app/utils/cli";
import { Command, Option } from "commander";
import { glob } from "glob";
import { ALGOS, type HashAlgo, isHashAlgo } from "./lib/algorithms";
import {
    type ChecksumEntry,
    formatChecksumLine,
    parseChecksumFile,
    summarizeVerify,
    type VerifyResult,
} from "./lib/checksum-file";
import { hashChunks } from "./lib/hash-stream";

interface Options {
    algo: string;
    check?: string;
    quiet?: boolean;
}

async function* fileChunks(path: string): AsyncGenerator<Uint8Array> {
    const stream = Bun.file(path).stream();
    for await (const chunk of stream) {
        yield chunk;
    }
}

async function hashFile(algo: HashAlgo, path: string): Promise<string> {
    return hashChunks({ algo, chunks: fileChunks(path) });
}

async function expandGlobs(patterns: string[]): Promise<string[]> {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const pattern of patterns) {
        const matches = await glob(pattern, { nodir: true });
        matches.sort();
        for (const match of matches) {
            if (!seen.has(match)) {
                seen.add(match);
                result.push(match);
            }
        }
    }

    return result;
}

async function runCompute(algo: HashAlgo, patterns: string[]): Promise<number> {
    const files = await expandGlobs(patterns);

    if (files.length === 0) {
        out.error("No files matched.");
        logger.warn({ patterns }, "hash: zero files matched");
        return 1;
    }

    let failures = 0;
    for (const file of files) {
        try {
            const hex = await hashFile(algo, file);
            out.println(formatChecksumLine(hex, file));
        } catch (error) {
            failures++;
            out.error(`hash: ${file}: could not read`);
            logger.warn({ file, error }, "hash: failed to read file");
        }
    }

    return failures > 0 ? 1 : 0;
}

async function verifyEntries(algo: HashAlgo, entries: ChecksumEntry[]): Promise<VerifyResult[]> {
    const results: VerifyResult[] = [];

    for (const entry of entries) {
        try {
            const actual = await hashFile(algo, entry.path);
            results.push({ path: entry.path, ok: actual === entry.hex });
        } catch (error) {
            logger.debug({ path: entry.path, error }, "hash: verify read failed");
            results.push({ path: entry.path, ok: false, unreadable: true });
        }
    }

    return results;
}

async function runCheck(algo: HashAlgo, checkFile: string, quiet: boolean): Promise<number> {
    let text: string;
    try {
        text = await Bun.file(checkFile).text();
    } catch (error) {
        out.error(`hash: cannot open checksum file: ${checkFile}`);
        logger.error({ checkFile, error }, "hash: failed to read checksum file");
        return 1;
    }

    const entries = parseChecksumFile(text);
    if (entries.length === 0) {
        out.error(`hash: no checksum entries found in ${checkFile}`);
        return 1;
    }

    const results = await verifyEntries(algo, entries);

    for (const result of results) {
        if (result.ok) {
            if (!quiet) {
                out.println(`${result.path}: OK`);
            }
        } else if (result.unreadable) {
            out.println(`${result.path}: FAILED (could not read)`);
        } else {
            out.println(`${result.path}: FAILED`);
        }
    }

    const summary = summarizeVerify(results);
    if (summary.failed > 0) {
        out.error(`hash: ${summary.failed} of ${summary.total} computed checksums did NOT match`);
        return 1;
    }

    out.log.success(`hash: all ${summary.total} checksums OK`);
    return 0;
}

async function exitWith(code: number): Promise<never> {
    await out.flush();
    process.exit(code);
}

const program = new Command();

program
    .name("hash")
    .description("Compute & verify file checksums (md5/sha1/sha256/sha512/blake3). Coreutils-compatible.")
    .argument("[files...]", "Files or glob patterns to hash (quote globs)")
    .addOption(new Option("-a, --algo <algo>", "Hash algorithm").choices([...ALGOS]).default("sha256"))
    .option("-c, --check <file>", "Verify the checksum file at <file> instead of computing")
    .option("--quiet", "In --check mode, print only FAILED lines")
    .action(async (files: string[], options: Options) => {
        if (!isHashAlgo(options.algo)) {
            out.error(`Unknown algorithm: ${options.algo}`);
            await exitWith(1);
        }

        const algo = options.algo;

        if (options.check) {
            if (files.length > 0) {
                out.error("Cannot pass files together with --check.");
                await exitWith(1);
            }

            const code = await runCheck(algo, options.check, options.quiet ?? false);
            await exitWith(code);
        }

        if (files.length === 0) {
            out.error("No files given.");
            if (!isInteractive()) {
                out.log.info(suggestCommand("tools hash", { add: ["<file>", "--algo", "sha256"] }));
            }

            await exitWith(1);
        }

        const code = await runCompute(algo, files);
        await exitWith(code);
    });

await runTool(program, { tool: "hash" });
