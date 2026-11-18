import { writeFileSync } from "node:fs";
// lint-rules-ignore: the session to-do items are read from the question tool's decision log until P9's switch
import { decisionFiles } from "@app/question/lib/decisions/paths";
// lint-rules-ignore: the session to-do items are read from the question tool's decision log until P9's switch
import { kindOf, readDecisions } from "@app/question/lib/decisions/store";
import { toCliCommands } from "@genesiscz/utils/api-descriptor/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { FormatFlags } from "@genesiscz/utils/output/formats";
import { defineFormatter, emit, type Formatter } from "@genesiscz/utils/output/formatter";
import { errorDiagnostic, failReply, okReply, type Reply } from "@genesiscz/utils/output/reply";
import { WORK_CLI_POSITIONAL, type WorkMethodName, workApi, workMethods } from "@genesiscz/utils/work/api";
import { workFormatters } from "@genesiscz/utils/work/formatters";
import { type MirrorReport, mirrorSessionTodos } from "@genesiscz/utils/work/legacy/session-todos";
import { ingestLegacyHandoff, type ParityDifference, parityOf } from "@genesiscz/utils/work/legacy/shadow";
import { showItem } from "@genesiscz/utils/work/read";
import { setWorkConfigValue, workConfigPath } from "@genesiscz/utils/work/rules/load";
import { openWorkDb, withWorkDb } from "@genesiscz/utils/work/store/db";
import type { Command } from "commander";
import { openLegacySource } from "../adapters/legacy-source";
import { callWorkHere } from "../doors/service";
import { cliDoor } from "./emit";

const FORMAT_OPTIONS = [
    { flags: "--json", description: "print the reply object as JSON" },
    { flags: "--json-compact", description: "the data as columns and positional rows" },
    { flags: "--toon", description: "the data as TOON" },
    { flags: "--md", description: "the data as markdown" },
    { flags: "--format <format>", description: "text|md|json|json-compact|toon" },
];

const WRITE_OPTIONS = [
    {
        flags: "--request-id <id>",
        description: "a repeat with the same id returns the stored reply and writes nothing",
    },
    { flags: "--dry-run", description: "print the changes, write nothing" },
    {
        flags: "--owner-said <words>",
        description: "the owner's words when you act on them; they give you the owner's role",
    },
];

const VIEW_OPTIONS: Partial<Record<WorkMethodName, { flags: string; description: string }[]>> = {
    context: [{ flags: "--explain", description: "print the evidence of each fact and the candidates that lost" }],
    config: [{ flags: "--explain", description: "print the value of each layer" }],
};

function isMethod(name: string): name is WorkMethodName {
    return Object.hasOwn(workMethods, name);
}

function formatFlags(extra: Record<string, unknown>): FormatFlags {
    return {
        ...(typeof extra.format === "string" ? { format: extra.format } : {}),
        ...(extra.json === true ? { json: true } : {}),
        ...(extra.jsonCompact === true ? { jsonCompact: true } : {}),
        ...(extra.toon === true ? { toon: true } : {}),
        ...(extra.md === true ? { md: true } : {}),
    };
}

function emitAs<T>(reply: Reply<T>, formatter: Formatter<T>, flags: FormatFlags): void {
    emit(reply, formatter, flags, cliDoor);
}

/** Runs one method of `workApi` for the CLI and prints its reply. */
export async function runMethod(
    method: string,
    params: Record<string, unknown>,
    extra: Record<string, unknown>
): Promise<void> {
    if (!isMethod(method)) {
        return;
    }

    const reply = await callWorkHere(method, params, {
        ...(typeof extra.requestId === "string" ? { request: extra.requestId } : {}),
        ...(extra.dryRun === true ? { dryRun: true } : {}),
        ...(typeof extra.ownerSaid === "string" ? { ownerSaid: extra.ownerSaid } : {}),
        quiet: false,
    });
    const formatters = workFormatters({
        ...(typeof params.section === "string" ? { section: params.section } : {}),
        ...(extra.explain === true ? { explain: true } : {}),
    });
    // The formatter of this method; the door returns its reply as unknown, so the door widens the formatter.
    const formatter = formatters[method] as Formatter<unknown>;
    emitAs(reply, formatter, formatFlags(extra));
}

const fileFormatter = defineFormatter<{ file: string }>({ text: (d) => [`wrote ${d.file}`] });

function registerConfigSet(config: Command | undefined): void {
    config
        ?.command("set")
        .description(
            "Set one value of the machine file by a dotted path, e.g. projects.App.rules.types.bug.fields.where"
        )
        .argument("<path>", "a dotted path into ~/.genesis-tools/work/config.json")
        .argument("<json>", 'the value as JSON, e.g. \'{"level":"required"}\'; null removes the key')
        .option("--json", "print the reply object as JSON")
        .action(async (path: string, raw: string, opts: { json?: boolean }) => {
            const formatter = defineFormatter<{ path: string; file: string }>({
                text: (d) => [`set ${d.path} in ${d.file}`],
            });
            let value: unknown;

            try {
                value = SafeJSON.parse(raw, { strict: true });
            } catch (error) {
                emitAs(
                    failReply("config set", [errorDiagnostic("BAD_JSON", `The value is not JSON: ${String(error)}`)]),
                    formatter,
                    opts
                );
                return;
            }

            const result = await setWorkConfigValue({ path, value: value === null ? undefined : value });
            emitAs(
                result.ok
                    ? okReply("config set", { path, file: workConfigPath() })
                    : failReply("config set", [errorDiagnostic("CONFIG_REFUSED", result.problem)]),
                formatter,
                opts
            );
        });
}

export function registerWorkCommands(program: Command): void {
    const commands = toCliCommands(workApi, program, {
        positional: WORK_CLI_POSITIONAL,
        extra: (method) => [
            ...FORMAT_OPTIONS,
            ...(method.effect === "read" ? [] : WRITE_OPTIONS),
            ...(isMethod(method.name) ? (VIEW_OPTIONS[method.name] ?? []) : []),
        ],
        run: runMethod,
    });
    registerConfigSet(commands.get("config"));

    program
        .command("dump")
        .description("Write one item with everything it holds to a JSON file")
        .argument("<ref>")
        .requiredOption("--out <file>")
        .action((ref: string, opts: { out: string }) => {
            const db = openWorkDb();

            try {
                const shown = showItem(db, ref);

                if (shown === null) {
                    emitAs(failReply("dump", [errorDiagnostic("NOT_FOUND", `No item ${ref}.`)]), fileFormatter, {});
                    return;
                }

                writeFileSync(opts.out, `${SafeJSON.stringify(shown, null, 2)}\n`);
                emitAs(okReply("dump", { file: opts.out }), fileFormatter, {});
            } finally {
                db.close();
            }
        });

    const migrate = program.command("migrate").description("Bring the old stores into the work store");
    migrate
        .command("backfill")
        .description("Ingest every handoff of the old store (safe to repeat)")
        .option("--json", "print the reply object as JSON")
        .action((opts: { json?: boolean }) => {
            const db = openWorkDb();
            const source = openLegacySource({ catchUp: true });
            const formatter = defineFormatter<{ handoffs: number; failed: number; items: number }>({
                text: (d) => [`ingested ${d.handoffs} handoffs; the store holds ${d.items} items`],
            });

            try {
                let handoffs = 0;
                let failed = 0;

                for (const handoff of source.handoffs()) {
                    try {
                        ingestLegacyHandoff(db, handoff, source.events(handoff.id));
                        handoffs++;
                    } catch (error) {
                        failed++;
                        out.printlnErr(`${handoff.id}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }

                const items = (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
                emitAs(
                    failed > 0
                        ? failReply("migrate backfill", [
                              errorDiagnostic("BACKFILL_FAILED", `${failed} handoffs failed; see the lines above.`),
                          ])
                        : okReply("migrate backfill", { handoffs, failed, items }),
                    formatter,
                    opts
                );
            } finally {
                source.close();
                db.close();
            }
        });

    migrate
        .command("session-todos")
        .description("Mirror the numbered to-do items of the decision log into the work store (safe to repeat)")
        .option("--json", "print the reply object as JSON")
        .action((opts: { json?: boolean }) => {
            const rows = readDecisions(decisionFiles().file).filter((row) => kindOf(row) === "todo");
            const formatter = defineFormatter<MirrorReport>({
                text: (d) => [`session to-do items: ${d.created} new, ${d.changed} changed, ${d.unchanged} unchanged`],
            });
            const report = withWorkDb(undefined, (db) => mirrorSessionTodos(db, rows));
            emitAs(okReply("migrate session-todos", report), formatter, opts);
        });

    program
        .command("doctor")
        .description("Check the work store; --parity compares it with the old handoff read model (a pure read)")
        .option("--parity", "compare every handoff with the old read model")
        .option("--json", "print the reply object as JSON")
        .action((opts: { parity?: boolean; json?: boolean }) => {
            const db = openWorkDb();
            const source = openLegacySource({ catchUp: false });
            const formatter = defineFormatter<{ handoffs: number; differences: ParityDifference[] }>({
                text: (d) =>
                    d.differences.length === 0
                        ? [`parity: ${d.handoffs} handoffs, 0 differences`]
                        : d.differences.map((x) => `${x.handoff}${x.slot ? `:${x.slot}` : ""}  ${x.what}`),
            });

            try {
                const handoffs = source.handoffs();
                const differences = handoffs.flatMap((handoff) => parityOf(db, handoff));
                const diagnostics =
                    differences.length === 0
                        ? []
                        : [
                              errorDiagnostic(
                                  "PARITY",
                                  `${differences.length} differences. A process with old code wrote past the hook: restart it, then run the backfill.`
                              ),
                          ];
                emitAs(okReply("doctor", { handoffs: handoffs.length, differences }, { diagnostics }), formatter, opts);

                if (differences.length > 0) {
                    process.exitCode = 1;
                }
            } finally {
                source.close();
                db.close();
            }
        });
}
