import { actorHere } from "@app/work/adapters/actor";
import { contextHere } from "@app/work/adapters/context";
import { emit } from "@app/work/commands/emit";
import { out } from "@genesiscz/utils/logger";
import { errorDiagnostic, failReply, okReply } from "@genesiscz/utils/output/reply";
import { BIND_KINDS, bindContext, type ContextFact } from "@genesiscz/utils/work/context";
import { isOneOf } from "@genesiscz/utils/work/model/vocab";
import { openWorkDb } from "@genesiscz/utils/work/store/db";
import type { Command } from "commander";

function factLine(fact: ContextFact, explain: boolean): string {
    const how = `${fact.how.method}${fact.how.strength ? ` ${fact.how.strength}` : ""}: ${fact.how.source}`;
    return explain
        ? `${fact.path} = ${fact.value}  (${how}; ${fact.how.evidence})`
        : `${fact.path} = ${fact.value}  (${how})`;
}

export function registerContextCommand(program: Command): void {
    const context = program
        .command("context")
        .description("What this session works on, with how each fact was found (given, read, inferred); read-only")
        .option("--explain", "print the evidence of each fact and the candidates that lost")
        .option("--network", "ask the forge for the pull request instead of the local lookup cache")
        .option("--json", "print the reply object as JSON")
        .action(async (opts: { explain?: boolean; network?: boolean; json?: boolean }) => {
            const { actor } = actorHere({ model: false });
            const db = openWorkDb();

            try {
                const { report } = await contextHere({ actor, db, network: opts.network === true });
                const data = { session: actor.sessionId, harness: actor.harness, ...report };
                emit(okReply("context", data), opts, (d) => {
                    const lines = [`session ${d.session ?? "(none)"} (${d.harness})`];
                    const current = Object.values(d.current);
                    lines.push(
                        ...(current.length > 0
                            ? current.map((f) => factLine(f, opts.explain === true))
                            : ["no current facts"])
                    );

                    if (opts.explain && d.candidates.length > 0) {
                        lines.push("candidates:", ...d.candidates.map((f) => `  ${factLine(f, true)}`));
                    }

                    return lines;
                });
            } finally {
                db.close();
            }
        });

    context
        .command("bind")
        .description('Declare what this session works for, e.g. --kind improve --target "gt-hub iteration 3"')
        .requiredOption("--kind <kind>", BIND_KINDS.join("|"))
        .requiredOption("--target <text>")
        .option("--json", "print the reply object as JSON")
        .action((opts: { kind: string; target: string; json?: boolean }) => {
            const { actor } = actorHere({ model: false });

            if (!isOneOf(BIND_KINDS, opts.kind)) {
                emit(
                    failReply("context bind", [
                        errorDiagnostic("BAD_VALUE", `--kind must be one of: ${BIND_KINDS.join(", ")}.`),
                    ]),
                    opts,
                    () => []
                );
                return;
            }

            if (actor.sessionId === null) {
                out.printlnErr("This shell runs in no agent session, so there is nothing to bind.");
                process.exitCode = 1;
                return;
            }

            const bindings = bindContext(actor.sessionId, {
                kind: opts.kind,
                target: opts.target,
                ts: new Date().toISOString(),
            });
            emit(okReply("context bind", { session: actor.sessionId, bindings }), opts, (d) =>
                d.bindings.map((b) => `bound.${b.kind} = ${b.target}`)
            );
        });
}
