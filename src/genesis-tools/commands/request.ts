import { spawnToolDetached } from "@genesiscz/utils/cli";
import { createRequestJournal, requestViewSchema } from "@genesiscz/utils/genesis-tools/areas/person/journal";
import { requestOutcomeSchema } from "@genesiscz/utils/genesis-tools/areas/person/request";
import { callRunningService, ensureGenesisToolsService } from "@genesiscz/utils/genesis-tools/service/clients";
import { out } from "@genesiscz/utils/logger";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import type { Command } from "commander";

export function registerRequestCommand(program: Command): void {
    const request = program.command("request").description("Inspect, present or withdraw a person request");
    request.command("list").action(async () => {
        const remote = await callRunningService("requests.list", {});
        out.result(remote.called ? remote.value : createRequestJournal().list().slice(-100));
    });
    request
        .command("show")
        .argument("<id>")
        .action(async (id: string) => {
            const remote = await callRunningService("requests.get", { id });
            out.result(remote.called ? remote.value : createRequestJournal().get(id));
        });
    request
        .command("withdraw")
        .argument("<id>")
        .action(async (id: string) => {
            const remote = await callRunningService("requests.withdraw", { id });
            out.result(remote.called ? remote.value : await createRequestJournal().withdraw(id));
        });
    request
        .command("open")
        .argument("<id>")
        .action((id: string) => {
            refuseHostEffectInTest("request worker", "Inject a worker launcher in tests.");
            spawnToolDetached(["genesis-tools", "request", "run", id], { reparent: true });
            out.result({ id, opened: true });
        });
    request
        .command("run")
        .argument("<id>")
        .action(async (id: string) => {
            const client = await ensureGenesisToolsService();
            try {
                const view = requestViewSchema.nullable().parse(await client.call("requests.get", { id }));
                if (!view) {
                    throw new Error(`Request ${id} does not exist.`);
                }
                if (view.outcome.status !== "pending") {
                    out.result(view.outcome);
                    return;
                }
                const raw = await client.call("person.showWindow", view.request, { timeoutMs: 120_000 });
                const outcome = requestOutcomeSchema.parse(
                    typeof raw === "object" && raw !== null && "value" in raw
                        ? raw.value
                        : { id, status: "unreachable", reason: "No request surface could run." }
                );
                if (outcome.status === "done" || outcome.status === "declined") {
                    out.result(
                        await client.call("requests.answer", { id, status: outcome.status, reason: outcome.reason })
                    );
                } else {
                    out.result(outcome);
                }
            } finally {
                client.close();
            }
        });
}
