import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { liveEngineDeps } from "@genesiscz/utils/genesis-tools/actions/registry";
import { explainAction, findAction, runAreaAction } from "@genesiscz/utils/genesis-tools/actions/run";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { callRunningService } from "@genesiscz/utils/genesis-tools/service/clients";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { registerCliAppBuilder } from "../lib/app-builder";

function parseArgs(json: string | boolean | undefined): unknown {
    return typeof json === "string" ? SafeJSON.parse(json, { strict: true }) : {};
}

async function explain(
    id: string,
    options: { fresh?: boolean; json?: string | boolean; format?: string }
): Promise<void> {
    const remote = await callRunningService("actions.explain", {
        id,
        fresh: options.fresh === true,
        args: parseArgs(options.json),
    });
    const result = remote.called
        ? (await import("@genesiscz/utils/genesis-tools/service/api")).explainSchema.parse(remote.value)
        : await explainAction(AREAS, id, liveEngineDeps(AREAS), {
              fresh: options.fresh === true,
              args: parseArgs(options.json),
          });

    if (options.json === true || options.format === "json") {
        out.result(result);
        return;
    }

    out.println(`${pc.bold(result.id)}  ${pc.dim(result.summary)}`);

    for (const way of result.ways) {
        const mark = way.way === result.first ? pc.green("→") : " ";
        out.println(
            `${mark} ${pc.bold(way.way)}${way.needsKnown ? "" : pc.dim("  (needs depend on the args: pass --json)")}`
        );

        for (const need of way.needs) {
            const status = need.ok ? pc.green("ok  ") : pc.red(need.code ?? "no");
            out.println(
                `    ${status} ${need.need} ${pc.dim(`[${need.from}]`)}${need.reason ? `  ${need.reason}` : ""}`
            );

            if (need.fix) {
                out.println(`         fix: ${need.fix.command}`);
            }
        }
    }

    out.println(pc.dim(`config: ${SafeJSON.stringify(result.config)}`));
    if (result.first) {
        out.println(`a run now takes ${result.first}`);
    } else if (result.ways.some((way) => !way.needsKnown)) {
        out.println("pass the args with --json to see which way a run takes");
    } else {
        out.println("no way can run now");
    }
}

export function registerActionCommand(program: Command): void {
    program
        .command("action")
        .description("Run a GenesisTools action (<area>.<action>), or explain its ways on this machine")
        .argument("<id>", "<area>.<action>, or `explain`")
        .argument("[target]", "with `explain`: the <area>.<action> to explain")
        .option("--json [args]", "arguments as JSON; without args, explain prints JSON")
        .option("--fresh", "explain: probe instead of reading state (writes state only)")
        .option("--timeout-ms <ms>", "action deadline in milliseconds")
        .option("--format <format>", "explain: text or json", "text")
        .action(
            async (
                id: string,
                target: string | undefined,
                options: { json?: string | boolean; fresh?: boolean; format?: string; timeoutMs?: string }
            ) => {
                if (id === "explain") {
                    if (!target) {
                        out.error(
                            `explain needs an action: ${toolCommand("genesis-tools action explain")} <area>.<action>`
                        );
                        process.exitCode = 1;
                        return;
                    }

                    await explain(target, options);
                    return;
                }

                const timeoutMs =
                    options.timeoutMs === undefined
                        ? (findAction(AREAS, id).action.timeoutMs ?? 120_000)
                        : Number(options.timeoutMs);
                if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                    throw new Error("--timeout-ms must be positive");
                }
                const remote = await callRunningService(id, parseArgs(options.json), timeoutMs + 10_000);
                if (!remote.called) {
                    registerCliAppBuilder();
                }
                const outcome = remote.called
                    ? remote.value
                    : await runAreaAction(AREAS, id, parseArgs(options.json), liveEngineDeps(AREAS), { timeoutMs });
                out.result(outcome);

                if (
                    typeof outcome !== "object" ||
                    outcome === null ||
                    !("status" in outcome) ||
                    outcome.status !== "ran"
                ) {
                    process.exitCode = 1;
                }
            }
        );
}
