import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { availableTransparentWriter, type TransparentWriter } from "@genesiscz/utils/compress/transparent";
import type { TransparentAlgorithm } from "@genesiscz/utils/compress/transparent-native";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { type TransparentOptions as Options, runTransparentPaths } from "../lib/transparent";

const ALGORITHMS = ["zlib", "lzvn", "lzfse"] as const;
async function writerFor(value: string | boolean | undefined, mode: string): Promise<TransparentWriter | null> {
    if (value === undefined) {
        return availableTransparentWriter();
    }

    const selected = await pickEnumFlag({
        tool: "compress",
        subcommand: ["transparent", mode],
        flag: "--algorithm",
        given: value,
        values: ALGORITHMS,
        fallback: availableTransparentWriter().algorithm,
        accepts: (input: string): input is TransparentAlgorithm => ALGORITHMS.includes(input as TransparentAlgorithm),
    });
    return selected === null ? null : availableTransparentWriter(selected);
}

export function registerTransparentCommands(program: Command): void {
    const transparent = program
        .command("transparent")
        .description("APFS compression at the same path; plan is read-only, apply preserves and verifies every file");
    for (const mode of ["plan", "apply"] as const) {
        transparent
            .command(mode)
            .argument("[paths...]", "folders to scan; default agent preset")
            .option(
                "--root <dir>",
                "additional root (repeatable)",
                (value: string, previous: string[]) => [...previous, value],
                []
            )
            .option(
                "--mirror <from=to>",
                "explicit clone partner hint (repeatable)",
                (value: string, previous: string[]) => [...previous, value],
                []
            )
            .option("--preset <name>", "agents: configured harness roots")
            .option("--older <duration>", "minimum file age, defaults to configured 3d")
            .option("--min-kb <n>", "minimum logical size, defaults to configured 64 KiB")
            .option("--ext <list>", "comma-separated text extensions")
            .option(
                "--algorithm [algorithm]",
                "zlib, lzvn, lzfse; default LZFSE with afsctool, actual ditto codec otherwise"
            )
            .option("--on-battery", "explicitly permit apply on battery")
            .option("--json", "machine-readable result")
            .action(async (paths: string[], options: Options) => {
                const writer = await writerFor(options.algorithm, mode);
                if (!writer) {
                    return;
                }

                const result = await runTransparentPaths({ paths, options, apply: mode === "apply", writer });
                if (options.json) {
                    out.result(result);
                } else {
                    out.println(
                        `${mode === "plan" ? "Dry run" : "Apply"}: ${result.files} files, ${formatBytes(result.inputBytes)} allocated, ${result.writer}/${result.algorithm}`
                    );
                    out.println(
                        `Left out: ${Object.entries(result.skips)
                            .map(([reason, count]) => `${count} ${reason}`)
                            .join(", ")}`
                    );
                    if (result.skips["too-big"] > 0) {
                        out.println(`${formatBytes(result.tooBigBytes)} too big: ${result.tooBigReason}`);
                    }

                    if (mode === "plan") {
                        const table = createBoxTable(["FILE", "ALLOCATED", "CLONE PARTNERS"]);
                        for (const candidate of result.candidates.slice(0, 100)) {
                            table.push([
                                candidate.path,
                                formatBytes(candidate.alloc),
                                candidate.partners?.join("\n") || "none known",
                            ]);
                        }

                        out.println(table.toString());
                        if (result.candidates.length > 100) {
                            out.println(`Showing 100 of ${result.candidates.length}; --json includes every candidate.`);
                        }
                    } else if ("savedBytes" in result) {
                        out.println(
                            `${formatBytes(result.savedBytes)} conservative saving; ${formatBytes(result.outputBytes)} allocated after.`
                        );
                        if (result.skippedBattery) {
                            out.println("Battery power: apply skipped. --on-battery explicitly overrides.");
                        }

                        for (const outcome of result.outcomes.filter((item) => item.status !== "compressed")) {
                            out.println(`${outcome.status}: ${outcome.path}${outcome.note ? `: ${outcome.note}` : ""}`);
                        }
                    }
                }
                if (result.failed) {
                    process.exitCode = 1;
                }
            });
    }
}
