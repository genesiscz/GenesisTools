// lint-rules-ignore: tools agents context is a door of the work store's preflight context (spec P4 decision 1)
import { actorHere } from "@app/work/adapters/actor";
// lint-rules-ignore: tools agents context is a door of the work store's preflight context (spec P4 decision 1)
import { cliDoor } from "@app/work/commands/emit";
// lint-rules-ignore: tools agents context is a door of the work store's preflight context (spec P4 decision 1)
import { runMethod } from "@app/work/commands/register";
import { defineFormatter, emit } from "@genesiscz/utils/output/formatter";
import { errorDiagnostic, failReply, okReply } from "@genesiscz/utils/output/reply";
import { BIND_KINDS, type Binding, bindContext } from "@genesiscz/utils/work/context";
import { isOneOf } from "@genesiscz/utils/work/model/vocab";
import type { Command } from "commander";

const bindFormatter = defineFormatter<{ session: string; bindings: Binding[] }>({
    text: (d) => d.bindings.map((b) => `bound.${b.kind} = ${b.target}`),
});

export function registerContextCommand(program: Command): void {
    const context = program
        .command("context")
        .description("What this session works on, with how each fact was found (given, read, inferred); read-only")
        .option("--explain", "print the evidence of each fact and the candidates that lost")
        .option("--network", "ask the forge for the pull request instead of the local lookup cache")
        .option("--json", "print the reply object as JSON")
        .action(async (opts: { explain?: boolean; network?: boolean; json?: boolean }) => {
            // The same method as `tools work context`: one handler, one formatter.
            await runMethod("context", opts.network ? { network: true } : {}, {
                ...(opts.explain ? { explain: true } : {}),
                ...(opts.json ? { json: true } : {}),
            });
        });

    context
        .command("bind")
        .description('Declare what this session works for, e.g. --kind improve --target "gt-hub iteration 3"')
        .option("--kind [kind]", BIND_KINDS.join("|"))
        .requiredOption("--target <text>")
        .option("--json", "print the reply object as JSON")
        .action(async (opts: { kind?: string | true; target: string; json?: boolean }) => {
            if (typeof opts.kind !== "string" || !isOneOf(BIND_KINDS, opts.kind)) {
                const refused = failReply<{ session: string; bindings: Binding[] }>("context bind", [
                    errorDiagnostic("BAD_VALUE", `--kind must be one of: ${BIND_KINDS.join(", ")}.`),
                ]);
                emit(refused, bindFormatter, opts, cliDoor);
                return;
            }

            const { actor } = actorHere({ model: false });
            if (actor.sessionId === null) {
                const refused = failReply<{ session: string; bindings: Binding[] }>("context bind", [
                    errorDiagnostic("NO_SESSION", "This shell runs in no agent session, so there is nothing to bind."),
                ]);
                emit(refused, bindFormatter, opts, cliDoor);
                return;
            }

            const bindings = await bindContext({
                sessionId: actor.sessionId,
                binding: { kind: opts.kind, target: opts.target, ts: new Date().toISOString() },
            });
            emit(okReply("context bind", { session: actor.sessionId, bindings }), bindFormatter, opts, cliDoor);
        });
}
