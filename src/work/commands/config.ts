import { SafeJSON } from "@genesiscz/utils/json";
import { errorDiagnostic, failReply, okReply } from "@genesiscz/utils/output/reply";
import { ITEM_TYPES, type ItemType } from "@genesiscz/utils/work/model/vocab";
import { RULE_FIELDS, WRITE_VERBS } from "@genesiscz/utils/work/rules/config";
import { loadWorkRules, setWorkConfigValue, workConfigPath } from "@genesiscz/utils/work/rules/load";
import type { Command } from "commander";
import { actorHere } from "../adapters/actor";
import { emit } from "./emit";

function show(value: unknown): string {
    return typeof value === "string" ? value : SafeJSON.stringify(value);
}

export function registerConfigCommand(program: Command): void {
    const config = program
        .command("config")
        .description("The effective work rules of a project; --explain names the layer that set each value (read-only)")
        .option("--project <p>", "the main checkout folder name (default: this checkout's)")
        .option("--type <t,…>", `only these types (${ITEM_TYPES.join(",")})`)
        .option("--explain", "print the value of each layer, not only the effective one")
        .option("--json", "print the reply object as JSON")
        .action(async (opts: { project?: string; type?: string; explain?: boolean; json?: boolean }) => {
            const { actor, project: here } = actorHere({ model: false });
            const project = opts.project ?? here;
            const loaded = await loadWorkRules({
                project,
                repoRoot: opts.project === undefined ? actor.repoRoot : null,
            });
            const types = (opts.type?.split(",").map((t) => t.trim()) ?? [...ITEM_TYPES]).filter((t): t is ItemType =>
                (ITEM_TYPES as readonly string[]).includes(t)
            );
            const rows = types.map((type) => ({
                type,
                fields: RULE_FIELDS.map((field) => ({ field, resolved: loaded.rules.field(type, field) })).filter(
                    (entry) => entry.resolved.value.level !== "optional"
                ),
                writes: Object.fromEntries(WRITE_VERBS.map((verb) => [verb, loaded.rules.mayWrite(type, verb)])),
            }));
            const data = { project, file: workConfigPath(), sources: loaded.sources, rows };
            emit(okReply("config", data, { diagnostics: loaded.problems }), opts, (d) => {
                const lines = [`project ${d.project}`, ...d.sources.map((s) => `  layer ${s.layer}: ${s.path ?? "?"}`)];

                for (const row of d.rows) {
                    lines.push(`${row.type}:`);

                    for (const { field, resolved } of row.fields) {
                        const measure = resolved.value.measure ? `: ${resolved.value.measure}` : "";
                        lines.push(`  field ${field}: ${resolved.value.level} (from ${resolved.from})${measure}`);

                        if (opts.explain) {
                            lines.push(
                                ...resolved.layers.map((l) => `      ${l.layer}: ${l.value ? l.value.level : "-"}`)
                            );
                        }
                    }

                    for (const [verb, resolved] of Object.entries(row.writes)) {
                        const value =
                            resolved.value === "anyone"
                                ? "anyone"
                                : resolved.value.length === 0
                                  ? "nobody"
                                  : resolved.value.join(", ");
                        lines.push(`  write ${verb}: ${value} (from ${resolved.from})`);

                        if (opts.explain) {
                            lines.push(
                                ...resolved.layers.map(
                                    (l) => `      ${l.layer}: ${l.value === undefined ? "-" : show(l.value)}`
                                )
                            );
                        }
                    }
                }

                return lines;
            });
        });

    config
        .command("set")
        .description(
            'Set one value of ~/.genesis-tools/work/config.json by a dotted path, e.g. projects.App.rules.types.bug.fields.where \'{"level":"required"}\''
        )
        .argument("<path>", "a dotted path into the machine file")
        .argument("<json>", "the value as JSON; null removes the key")
        .option("--json", "print the reply object as JSON")
        .action(async (path: string, raw: string, opts: { json?: boolean }) => {
            let value: unknown;

            try {
                value = SafeJSON.parse(raw, { strict: true });
            } catch (error) {
                emit(
                    failReply("config set", [errorDiagnostic("BAD_JSON", `The value is not JSON: ${String(error)}`)]),
                    opts,
                    () => []
                );
                return;
            }

            const result = await setWorkConfigValue({ path, value: value === null ? undefined : value });

            if (!result.ok) {
                emit(failReply("config set", [errorDiagnostic("CONFIG_REFUSED", result.problem)]), opts, () => []);
                return;
            }

            emit(okReply("config set", { path, file: workConfigPath() }), opts, (d) => [`set ${d.path} in ${d.file}`]);
        });
}
