import { isInteractive, runTool, suggestCommand } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger, out } from "@genesiscz/utils/logger";
import { Command, Option } from "commander";
import { ALGOS, type HashAlgo, HEX_LENGTH, isHashAlgo } from "./lib/algorithms";
import { formatChecksumLine } from "./lib/checksum-file";
import { describeReadError, hashFile, hashStdin } from "./lib/hash-stream";
import { expandInputs } from "./lib/inputs";
import { verifyChecksums } from "./lib/verify";

interface Options {
    algo: string;
    check?: string;
    quiet?: boolean;
    status?: boolean;
    warn?: boolean;
    strict?: boolean;
    ignoreMissing?: boolean;
}

const ALGO_NOTES: Record<HashAlgo, string> = {
    md5: "for checksums other people published; do not pick it for anything new",
    sha1: "for checksums other people published; do not pick it for anything new",
    sha256: "the default, and the one everyone can verify",
    sha512: "longer digest, same trust as sha256",
    blake3: "not in coreutils; runs as WebAssembly here, so slower than sha256",
};

const EXAMPLES: Array<{ line: string; note: string }> = [
    { line: toolCommand("hash", "installer.dmg"), note: "sha256 of one file" },
    { line: toolCommand("hash", "-a", "blake3", "dist/"), note: "blake3 of every file under dist/" },
    { line: `cat data.bin | ${toolCommand("hash", "-a", "sha512")}`, note: "hash stdin" },
    { line: `${toolCommand("hash", "'dist/**/*.js'")} > SHA256SUMS`, note: "write a checksum file" },
    { line: toolCommand("hash", "-c", "SHA256SUMS"), note: "verify it (exit 1 on any failure)" },
];

function algorithmHelp(): string {
    const rows = ALGOS.map(
        (algo) => `  ${algo.padEnd(7)} ${String(HEX_LENGTH[algo]).padStart(3)} hex digits  ${ALGO_NOTES[algo]}`
    );
    const width = Math.max(...EXAMPLES.map((example) => example.line.length));
    const examples = EXAMPLES.map((example) => `  ${example.line.padEnd(width)}  ${example.note}`);

    return [
        "",
        "Algorithms:",
        ...rows,
        "",
        "Files, directories and stdin:",
        "  A directory is hashed file by file, recursively. A quoted glob is expanded by this tool. '-' (or no",
        "  file at all, with input piped in) hashes stdin and prints '-' as the name.",
        "",
        "Examples:",
        ...examples,
        "",
    ].join("\n");
}

async function runCompute(algo: HashAlgo, argumentsList: string[]): Promise<number> {
    const inputs = await expandInputs(argumentsList);

    if (inputs.length === 0) {
        out.error("No files matched.");
        logger.warn({ arguments: argumentsList }, "hash: zero files matched");
        return 1;
    }

    let failures = 0;
    for (const input of inputs) {
        if (input.kind === "error") {
            failures++;
            out.printlnErr(`hash: ${input.path}: ${input.message}`);
            continue;
        }

        const name = input.kind === "stdin" ? "-" : input.path;
        try {
            const hex = input.kind === "stdin" ? await hashStdin(algo) : await hashFile(algo, input.path);
            out.println(formatChecksumLine(hex, name));
        } catch (error) {
            failures++;
            out.printlnErr(`hash: ${name}: ${describeReadError(error)}`);

            // A missing file is common and already fully explained by the line above;
            // only an unusual read failure (permissions, I/O error) earns the console
            // WARN with its full detail (#446 item 8).
            const notFound = error instanceof Error && "code" in error && error.code === "ENOENT";
            if (notFound) {
                logger.debug({ file: name, error }, "hash: failed to read file (not found)");
            } else {
                logger.warn({ file: name, error }, "hash: failed to read file");
            }
        }
    }

    return failures > 0 ? 1 : 0;
}

async function runCheck(checkFile: string, explicitAlgo: HashAlgo | undefined, options: Options): Promise<number> {
    const fromStdin = checkFile === "-";
    let text: string;
    try {
        text = fromStdin ? await Bun.stdin.text() : await Bun.file(checkFile).text();
    } catch (error) {
        out.printlnErr(`hash: ${checkFile}: ${describeReadError(error)}`);
        logger.error({ checkFile, error }, "hash: failed to read checksum file");
        return 1;
    }

    // As in coreutils, a `-` entry names standard input, which is what `tools hash` prints for piped data.
    const hashListed = (hashAlgo: HashAlgo, path: string): Promise<string> => {
        if (path !== "-") {
            return hashFile(hashAlgo, path);
        }

        if (fromStdin) {
            return Promise.reject(new Error("standard input already holds the checksum list"));
        }

        return hashStdin(hashAlgo);
    };

    const report = await verifyChecksums(text, {
        label: fromStdin ? "standard input" : checkFile,
        algo: explicitAlgo,
        quiet: options.quiet ?? false,
        status: options.status ?? false,
        strict: options.strict ?? false,
        warn: options.warn ?? false,
        ignoreMissing: options.ignoreMissing ?? false,
        hashPath: hashListed,
        onLine: (line) => out.println(line),
        onMessage: (message) => out.printlnErr(message),
    });

    logger.debug({ checkFile, checked: report.checked, ok: report.ok, exitCode: report.exitCode }, "hash: verified");

    if (report.exitCode === 0 && report.ok > 0 && !options.status) {
        out.log.success(`hash: all ${report.ok} checksums OK`);
    }

    return report.exitCode;
}

async function exitWith(code: number): Promise<never> {
    await out.flush();
    process.exit(code);
}

const program = new Command();

program
    .name("hash")
    .description("Compute & verify file checksums (md5/sha1/sha256/sha512/blake3). Coreutils-compatible.")
    .argument("[files...]", "Files, directories, '-' (stdin) or glob patterns to hash (quote globs)")
    .addOption(new Option("-a, --algo <algo>", "Hash algorithm").choices([...ALGOS]).default("sha256"))
    .option("-c, --check <file>", "Verify the checksum file at <file> ('-' for stdin) instead of computing")
    .option("-q, --quiet", "In --check mode, print only FAILED lines")
    .option("-s, --status", "In --check mode, print nothing; the exit code says whether everything matched")
    .option("-w, --warn", "In --check mode, warn about improperly formatted lines")
    .option("--strict", "In --check mode, exit 1 when any line is improperly formatted")
    .option("--ignore-missing", "In --check mode, skip files that do not exist instead of failing")
    .addHelpText("after", algorithmHelp())
    .action(async (files: string[], options: Options, command: Command) => {
        if (!isHashAlgo(options.algo)) {
            out.error(`Unknown algorithm: ${options.algo}`);
            return await exitWith(1);
        }

        const algo = options.algo;

        if (options.check) {
            if (files.length > 0) {
                out.error("Cannot pass files together with --check.");
                return await exitWith(1);
            }

            const explicitAlgo = command.getOptionValueSource("algo") === "cli" ? algo : undefined;
            const code = await runCheck(options.check, explicitAlgo, options);
            return await exitWith(code);
        }

        if (files.length === 0) {
            if (isInteractive()) {
                out.error("No files given.");
                out.log.info(suggestCommand("tools hash", { add: ["<file>", "--algo", "sha256"] }));
                return await exitWith(1);
            }

            return await exitWith(await runCompute(algo, ["-"]));
        }

        const code = await runCompute(algo, files);
        return await exitWith(code);
    });

await runTool(program, { tool: "hash" });
