import { type LogsOptions, printLogs, printTranscript } from "@app/codex/commands/logs";
import { THOUGHT_MODES, TRANSCRIPT_FORMATS } from "@genesiscz/utils/ai/transcripts/render";
import { logger, out } from "@genesiscz/utils/logger";
import { formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import type { WorkerDriver, WorkerVerbOutcome } from "@genesiscz/utils/worker/driver";
import type { CodexControl } from "./control";
import { sendControlRequest } from "./control-channel";
import { isCodexDaemonPid, parseWritePolicy, schemaDriftWarning, spawnCodexSession } from "./spawn";
import { type CodexSessionMeta, CodexSessionStore, deriveSessionStatus } from "./store";
import { followSessionEvents } from "./tail-events";

const log = logger.child({ component: "codex:driver" });

/**
 * Codex is the one backend that is a persistent daemon with a control channel, so every verb
 * that reaches a live session goes over that channel and answers with an acknowledgement
 * rather than a finished turn. That is also why `stop` and `interrupt` are two operations
 * here and one everywhere else: `stop` tears the daemon down, `interrupt` ends the turn.
 */

async function control(name: string, request: CodexControl, fallback: unknown = {}): Promise<WorkerVerbOutcome> {
    const response = await sendControlRequest(name, request);

    if (!response.ok) {
        throw new Error(response.error);
    }

    return { kind: "ack", result: response.result ?? fallback };
}

export const codexDriver: WorkerDriver<CodexSessionMeta> = {
    backend: "codex",
    store: new CodexSessionStore(),
    help: {
        spawn: "a long-lived app-server session, driven afterwards over its control channel",
        steer: "Inject input into a running Codex turn; returns as soon as the daemon accepts it",
        read: "the current thread snapshot",
        tail: "Show a session's recent events, and follow them with --follow",
    },
    // A codex session starts and waits: the first prompt may arrive as a steer instead.
    spawnFlags: { promptOptional: true },
    legacyPromptFlags: { text: "body", file: "bodyFile" },

    extendSpawn(command) {
        command
            .option("--computer-use", "Configure installed official Mac Computer Use for this worker")
            .option("--home <path>", "CODEX_HOME override")
            .option("--effort <effort>", "Reasoning effort")
            .option("--write <policy>", "ask | allow | deny")
            .option("--mode <mode>", "review | task", "task")
            .option("--no-agents", "Disable tools agents integration")
            .option("--session <id>", "Parent tools agents session id")
            .option("--writable-root <path...>", "Additional writable roots");
    },

    extendSteer(command) {
        command.option("--force", "Interrupt then start if same-turn steering is rejected");
        // `--body` predates `--prompt`; every other backend spells this `--prompt`, so the old
        // spelling stays forever and stays hidden. `legacyPromptFlags` is what finds it.
        command.addOption(command.createOption("--body <text>", "older spelling of --prompt").hideHelp());
        command.addOption(command.createOption("--body-file <path>", "older spelling of --prompt-file").hideHelp());
    },

    extendTail(command) {
        command
            .option("--tail <count>", "Show the last N existing events", "20")
            .option("--follow", "Follow until the session closes")
            .option("--events", "Print normalized worker events instead of raw notifications")
            .option("--format [value]", `render the session as a transcript: ${TRANSCRIPT_FORMATS.join(" | ")}`)
            .option("--thoughts [value]", `reasoning in the compact and events formats: ${THOUGHT_MODES.join(" | ")}`);
    },

    async spawn(input) {
        const extras = input.extras as {
            computerUse?: boolean;
            home?: string;
            effort?: string;
            write?: string;
            mode?: string;
            agents?: boolean;
            session?: string;
            writableRoot?: string[];
        };

        if (extras.mode !== "review" && extras.mode !== "task") {
            throw new Error("--mode must be review or task");
        }

        // A silent no-op here reads as isolation that was applied. It never was, so this
        // refuses instead of pretending: a caller who asked for isolation and did not get it
        // must find out now, not from a worker that turned out to load every skill.
        if (input.surfaces.skills === false || input.surfaces.rules === false) {
            const asked = [
                input.surfaces.skills === false ? "--no-skills" : "",
                input.surfaces.rules === false ? "--no-rules" : "",
            ]
                .filter(Boolean)
                .join(" and ");
            throw new Error(
                `${asked} cannot be honoured: codex has no skills/rules isolation control, so the flag would silently do nothing. Pass a lean --home <dir> instead, which is the only mechanism that actually limits what a codex worker loads (references/codex.md).`
            );
        }

        const meta = await spawnCodexSession({
            name: input.name,
            cwd: input.cwd,
            ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.account === undefined ? {} : { account: input.account }),
            ...(extras.computerUse === undefined ? {} : { computerUse: extras.computerUse }),
            ...(extras.home === undefined ? {} : { home: extras.home }),
            ...(extras.effort === undefined ? {} : { effort: extras.effort }),
            write: parseWritePolicy(extras.write),
            mode: extras.mode,
            agents: extras.agents,
            ...(extras.session === undefined ? {} : { rendezvousSession: extras.session }),
            ...(extras.writableRoot === undefined ? {} : { writableRoots: extras.writableRoot }),
        });
        const warning = schemaDriftWarning(meta.codexVersion);

        if (warning) {
            log.warn({ installed: meta.codexVersion }, warning);
            out.log.warn(warning);
        }

        return { kind: "ack", result: meta };
    },

    steer(meta, input) {
        return control(meta.name, {
            op: "steer",
            body: input.prompt,
            force: (input.extras as { force?: boolean }).force === true,
        });
    },

    async liveness(meta) {
        const status = deriveSessionStatus(meta);
        const alive = isCodexDaemonPid(meta.daemonPid, meta.name);

        return { running: alive && status === "running", pids: alive ? [meta.daemonPid] : [], detail: status };
    },

    interruptTurn: (meta) => control(meta.name, { op: "interrupt" }),
    shutdown: (meta) => control(meta.name, { op: "stop" }, { stopped: true }),

    async readDefault(meta) {
        const outcome = await control(meta.name, { op: "read" }, null);
        out.result(outcome.kind === "ack" ? outcome.result : null);
    },

    async tailDefault(meta, extras) {
        const flags = extras as Partial<LogsOptions> & { follow?: boolean };
        const options: LogsOptions = { ...flags, name: meta.name };

        if (options.format !== undefined) {
            await printTranscript(options, flags.follow === true, "tail");
            return;
        }

        await printLogs(options);

        if (flags.follow) {
            await followSessionEvents(meta.name, flags.events === true);
        }
    },

    rowHeaders: ["NAME", "STATUS", "DAEMON", "THREAD", "CWD"],

    row(meta) {
        const status = deriveSessionStatus(meta);
        const tone = status === "running" || status === "ready" ? "ok" : status === "failed" ? "err" : "dim";

        return [
            meta.name,
            formatDotStatus(tone, status),
            String(meta.daemonPid),
            meta.threadId ?? "—",
            truncateDisplay(meta.cwd, 40),
        ];
    },

    jsonRow: (meta) => ({ ...meta, derivedStatus: deriveSessionStatus(meta) }),
};
