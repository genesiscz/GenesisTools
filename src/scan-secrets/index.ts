import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { logger, out } from "@app/logger";
import { isInteractive, runTool, suggestCommand } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { Command } from "commander";
import { formatHuman, toJsonResult } from "./lib/report";
import { scanDirectory } from "./lib/scan-dir";

interface Options {
    json?: boolean;
    gitignore: boolean;
    ignore?: string[];
    maxSize: string;
    entropy: boolean;
}

function collect(value: string, previous: string[]): string[] {
    previous.push(value);
    return previous;
}

function compileIgnorePatterns(raw: string[] | undefined): RegExp[] {
    if (!raw) {
        return [];
    }

    const patterns: RegExp[] = [];
    for (const source of raw) {
        try {
            patterns.push(new RegExp(source));
        } catch (err) {
            logger.warn({ err, source }, "scan-secrets: invalid --ignore regex (skipped)");
        }
    }

    return patterns;
}

async function resolveDir(dirArg: string | undefined): Promise<string | null> {
    if (dirArg) {
        return resolve(dirArg);
    }

    if (!isInteractive()) {
        return process.cwd();
    }

    const answer = await out.text({
        message: "Directory to scan:",
        placeholder: ".",
        initialValue: ".",
    });

    if (out.isCancel(answer)) {
        return null;
    }

    return resolve(typeof answer === "string" && answer.length > 0 ? answer : ".");
}

async function main(dirArg: string | undefined, options: Options): Promise<void> {
    const dir = await resolveDir(dirArg);

    if (dir === null) {
        out.error("Cancelled.");
        await out.flush();
        process.exit(2);
    }

    let isDirectory = false;
    try {
        isDirectory = existsSync(dir) && statSync(dir).isDirectory();
    } catch (err) {
        logger.warn({ err, dir }, "scan-secrets: directory stat failed");
    }

    if (!isDirectory) {
        out.error(`Not a directory: ${dir}`);
        out.error(suggestCommand("tools scan-secrets", { add: ["<dir>"] }));
        await out.flush();
        process.exit(2);
    }

    const maxSizeText = options.maxSize.trim();
    const maxSizeKb = Number(maxSizeText);

    if (!/^\d+$/.test(maxSizeText) || !Number.isSafeInteger(maxSizeKb) || maxSizeKb <= 0) {
        out.error("--max-size must be a positive integer (KB).");
        await out.flush();
        process.exit(2);
    }

    const result = scanDirectory({
        dir,
        respectGitignore: options.gitignore,
        maxSizeKb,
        ignorePatterns: compileIgnorePatterns(options.ignore),
        disableEntropy: !options.entropy,
        now: new Date(),
    });

    logger.debug(
        { scanned: result.scannedFiles, skipped: result.skippedFiles, findings: result.findingCount },
        "scan-secrets: complete"
    );

    if (options.json) {
        out.result(SafeJSON.stringify(toJsonResult(result), null, 2));
    } else {
        out.result(formatHuman(result));
    }

    await out.flush();
    process.exit(result.findingCount > 0 ? 1 : 0);
}

const program = new Command()
    .name("scan-secrets")
    .description(
        "Scan a directory for hardcoded secrets (API keys, tokens, private keys). CI gate: exits non-zero on findings."
    )
    .argument("[dir]", "Directory to scan (default: current directory)")
    .option("--json", "Emit JSON to stdout instead of the human report")
    .option("--no-gitignore", "Do not respect .gitignore")
    .option("--ignore <regex>", "Allowlist: drop findings matching this regex (repeatable)", collect, [])
    .option("--max-size <kb>", "Skip files larger than this many KB", "1024")
    .option("--no-entropy", "Disable the high-entropy base64 detector")
    .action((dirArg: string | undefined, options: Options) => main(dirArg, options));

await runTool(program, { tool: "scan-secrets" });
