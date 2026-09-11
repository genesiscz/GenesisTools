import { readFileSync } from "node:fs";
import { runTranscriptDoor } from "@genesiscz/utils/ai/transcripts/door";
import { THOUGHT_MODES, TRANSCRIPT_FORMATS } from "@genesiscz/utils/ai/transcripts/render";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import { WORKER_CAPABILITIES } from "@genesiscz/utils/worker/capabilities";
import type { WorkerDriver, WorkerMeta, WorkerVerbOutcome } from "@genesiscz/utils/worker/driver";
import { surfacesFromFlags } from "@genesiscz/utils/worker/isolation";
import { printWorkerTurn } from "@genesiscz/utils/worker/turn-report";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * The headless-worker verbs, declared once for every coding-agent tool.
 *
 * `spawn`, `steer`, `read`, `tail`, `status`, `stop`, `interrupt` and `sessions` asked the
 * same questions three times over and answered them differently: the prompt flags were
 * `--prompt` on two tools and `--body` on the third, `sessions` had `--json` on one of three,
 * `status` refused a missing `--name` on two and listed everything on the third, and each
 * copy spelled "not found" its own way. All of that lives here now. A backend contributes
 * only what genuinely differs, through `WorkerDriver`.
 */

export interface WorkerVerbsOptions {
    /** What every hint and error prints: `tools grok`, `tools claude worker`. */
    tool: string;
    /** The path under the tool root, for the transcript door: `[]` or `["worker"]`. */
    subcommand: string[];
}

/** `--prompt` / `--prompt-file`, plus the older spelling a backend still accepts. */
export function readWorkerPrompt(
    flags: Record<string, unknown>,
    legacy?: { text: string; file: string }
): string | undefined {
    const text = (flags.prompt ?? (legacy ? flags[legacy.text] : undefined)) as string | undefined;
    const file = (flags.promptFile ?? (legacy ? flags[legacy.file] : undefined)) as string | undefined;

    if (text && file) {
        throw new Error("--prompt and --prompt-file are mutually exclusive");
    }

    if (file) {
        return readFileSync(file, "utf8");
    }

    return text;
}

function emit(outcome: WorkerVerbOutcome | undefined): void {
    if (!outcome) {
        return;
    }

    if (outcome.kind === "turn") {
        printWorkerTurn(outcome.report);
        return;
    }

    out.result(outcome.result ?? {});
}

export function registerWorkerVerbs<Meta extends WorkerMeta>(
    parent: Command,
    driver: WorkerDriver<Meta>,
    options: WorkerVerbsOptions
): void {
    const { tool, subcommand } = options;
    const caps = WORKER_CAPABILITIES[driver.backend];
    const store = driver.store;

    async function requireMeta(name: string): Promise<Meta> {
        const meta = await store.readMeta(name);

        if (!meta) {
            throw new Error(`${store.title} not found: ${name}. List them with: ${tool} sessions`);
        }

        return meta;
    }

    /** The one JSON shape `status` and `sessions --json` both answer with. */
    function jsonRow(meta: Meta): unknown {
        return driver.jsonRow ? driver.jsonRow(meta) : meta;
    }

    const spawn = parent
        .command("spawn")
        .description(`Start a headless ${driver.backend} worker: turn 1 of a new session (blocking; takes minutes)`)
        .requiredOption("--name <name>", "Session name")
        .option("--prompt <text>", "Inline brief")
        .option("--prompt-file <path>", "Read the brief from a file")
        .option("-m, --model <model>", "Model for the session")
        .option("--skills", "The worker loads your personal skills")
        .option("--no-skills", "The worker hides your personal skills")
        .option("--rules", "The worker loads your personal rules")
        .option("--no-rules", "The worker hides your personal rules");

    if (driver.spawnFlags?.cwdRequired) {
        spawn.requiredOption("--cwd <path>", "Working directory for the worker");
    } else {
        spawn.option("--cwd <path>", "Working directory for the worker (default: this one)");
    }

    if (caps.accountRequired) {
        spawn.requiredOption(
            "-a, --account <account>",
            "Account every turn is pinned to (required, never auto-picked)"
        );
    } else {
        spawn.option("-a, --account <account>", "Account every turn is pinned to");
    }

    driver.extendSpawn?.(spawn);
    spawn.action(async (flags: Record<string, unknown>) => {
        const prompt = readWorkerPrompt(flags);

        if (prompt === undefined && !driver.spawnFlags?.promptOptional) {
            throw new Error("A brief is required: pass --prompt '<text>' or --prompt-file <path>.");
        }

        emit(
            await driver.spawn({
                name: flags.name as string,
                cwd: (flags.cwd as string | undefined) ?? process.cwd(),
                ...(prompt === undefined ? {} : { prompt }),
                ...(flags.model === undefined ? {} : { model: flags.model as string }),
                ...(flags.account === undefined ? {} : { account: flags.account as string }),
                surfaces: surfacesFromFlags({
                    skills: flags.skills as boolean | undefined,
                    rules: flags.rules as boolean | undefined,
                }),
                extras: flags,
            })
        );
    });

    const steer = parent
        .command("steer")
        .description("Send the next instruction to an existing session (blocking; can take minutes)")
        .requiredOption("--name <name>", "Session name")
        .option("--prompt <text>", "Inline instruction")
        .option("--prompt-file <path>", "Read the instruction from a file");

    driver.extendSteer?.(steer);
    steer.action(async (flags: Record<string, unknown>) => {
        const prompt = readWorkerPrompt(flags, driver.legacyPromptFlags);

        if (prompt === undefined) {
            throw new Error("An instruction is required: pass --prompt '<text>' or --prompt-file <path>.");
        }

        const meta = await requireMeta(flags.name as string);
        emit(await driver.steer(meta, { prompt, extras: flags }));
    });

    const read = parent
        .command("read")
        .description(
            driver.turnFile
                ? `Re-print a finished turn: ${driver.readDefaultLabel} (default), or the transcript in a chosen --format`
                : `Read ${driver.readDefaultLabel}`
        )
        .requiredOption("--name <name>", "Session name");

    if (driver.turnFile) {
        read.option("--turn <n>", "Turn number (default: latest)")
            .option("--format [value]", `transcript shape: ${TRANSCRIPT_FORMATS.join(" | ")}`)
            .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`)
            .option("--events", "alias of --format events");
    }

    read.action(async (flags: Record<string, unknown>) => {
        const meta = await requireMeta(flags.name as string);
        const turn = flags.turn ? Number(flags.turn) : (driver.latestTurn?.(meta) ?? 0);

        if (driver.turnFile && (flags.format !== undefined || flags.events === true)) {
            await runTranscriptDoor({
                tool: `${tool} read`,
                subcommand: [...subcommand, "read"],
                provider: driver.backend,
                query: meta.name,
                format: flags.format as string | boolean | undefined,
                thoughts: flags.thoughts as string | boolean | undefined,
                events: flags.events === true,
                turnFile: driver.turnFile(meta, turn),
            });
            return;
        }

        await driver.readDefault(meta, turn);
    });

    const tail = parent
        .command("tail")
        .description("Follow the running turn's transcript as it is written; stops when the turn ends")
        .requiredOption("--name <name>", "Session name");

    if (driver.turnFile) {
        tail.option("--format [value]", `transcript shape: ${TRANSCRIPT_FORMATS.join(" | ")} (default compact)`).option(
            "--thoughts [value]",
            `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`
        );
    }

    driver.extendTail?.(tail);
    tail.action(async (flags: Record<string, unknown>) => {
        const meta = await requireMeta(flags.name as string);

        if (driver.tailDefault) {
            await driver.tailDefault(meta, flags);
            return;
        }

        await runTranscriptDoor({
            tool: `${tool} tail`,
            subcommand: [...subcommand, "tail"],
            provider: driver.backend,
            query: meta.name,
            format: flags.format as string | boolean | undefined,
            thoughts: flags.thoughts as string | boolean | undefined,
            follow: true,
            stillRunning: async () => (await driver.liveness(meta)).running,
        });
    });

    async function printSessions(json: boolean): Promise<void> {
        const names = await store.listNames();
        const metas: Meta[] = [];

        for (const name of names) {
            const meta = await store.readMeta(name);

            if (meta) {
                metas.push(meta);
            }
        }

        if (json) {
            out.result(metas.map(jsonRow));
            return;
        }

        if (metas.length === 0) {
            out.printlnErr(pc.dim(`No ${driver.backend} sessions.`));
            out.printlnErr(pc.dim(suggestCommand(`${tool} spawn`, { add: ["--name", "<task>"] })));
            return;
        }

        const table = createBoxTable([...driver.rowHeaders]);

        for (const meta of metas) {
            table.push(driver.row(meta));
        }

        out.println(table.toString());
    }

    parent
        .command("status")
        .description("Show a session's metadata, last turn, and whether a turn is running right now")
        .option("--name <name>", "Session name; omit to list every session")
        .option("--json", "Emit machine-readable JSON")
        .action(async (flags: { name?: string; json?: boolean }) => {
            if (!flags.name) {
                await printSessions(flags.json === true);
                return;
            }

            const meta = await requireMeta(flags.name);
            const live = await driver.liveness(meta);
            const row = jsonRow(meta);
            out.result({
                ...(typeof row === "object" && row !== null ? row : { meta: row }),
                running: live.running,
                runningPids: live.pids ?? [],
                ...(live.detail === undefined ? {} : { liveness: live.detail }),
            });
        });

    parent
        .command("sessions")
        .description(`List ${driver.backend} worker sessions`)
        .option("--json", "Emit machine-readable JSON")
        .action(async (flags: { json?: boolean }) => {
            await printSessions(flags.json === true);
        });

    /**
     * `stop` means "end this session" and `interrupt` means "end this turn". On a daemon
     * backend those are two different operations; everywhere else the turn IS the process, so
     * `stop` keeps its meaning and `interrupt` becomes an honest alias rather than a stub.
     */
    async function endTurnOrSession(name: string, shutdown: boolean): Promise<void> {
        const meta = await requireMeta(name);

        if (shutdown && driver.shutdown) {
            emit(await driver.shutdown(meta));
            return;
        }

        const live = await driver.liveness(meta);

        if (!live.running) {
            out.printlnErr(pc.dim(`No running turn for '${name}'. Nothing to stop.`));
            return;
        }

        emit(await driver.interruptTurn(meta));
        out.printlnErr(
            pc.dim(
                `Stopped the running turn of '${name}'. The session survives; '${tool} steer --name ${name}' resumes it.`
            )
        );
    }

    parent
        .command("stop")
        .description(
            driver.shutdown
                ? `Stop a ${driver.backend} session and tear its daemon down`
                : "Kill the currently running turn (the session survives; the next steer resumes it)"
        )
        .requiredOption("--name <name>", "Session name")
        .action(async (flags: { name: string }) => {
            await endTurnOrSession(flags.name, true);
        });

    parent
        .command("interrupt")
        .description("End the running turn; the session survives")
        .requiredOption("--name <name>", "Session name")
        .action(async (flags: { name: string }) => {
            await endTurnOrSession(flags.name, false);
        });

    // Verbs other backends have and this one deliberately lacks: name the capability matrix
    // instead of pretending commander never heard of them.
    for (const [verb, reason] of Object.entries(caps.absentVerbs)) {
        parent
            .command(verb, { hidden: true })
            .description(`Not available: ${reason}`)
            .action(() => {
                out.error(pc.red(`'${tool} ${verb}' does not exist by design: ${reason}`));
                out.printlnErr(
                    pc.dim(`See WORKER_CAPABILITIES.${driver.backend} in @genesiscz/utils/worker/capabilities.`)
                );
                process.exitCode = 1;
            });
    }
}
