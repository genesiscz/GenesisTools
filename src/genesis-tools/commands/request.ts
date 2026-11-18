import { spawnToolDetached } from "@genesiscz/utils/cli";
import type { ActionOutcome } from "@genesiscz/utils/genesis-tools/actions/define";
import { person } from "@genesiscz/utils/genesis-tools/areas/person";
import { createRequestJournal, requestViewSchema } from "@genesiscz/utils/genesis-tools/areas/person/journal";
import {
    type PersonRequest,
    presentPostedRequest,
    type RequestOutcome,
    requestOutcomeSchema,
} from "@genesiscz/utils/genesis-tools/areas/person/request";
import { windows } from "@genesiscz/utils/genesis-tools/areas/windows";
import {
    callRunningService,
    ensureGenesisToolsService,
    serviceActionClientTimeoutMs,
} from "@genesiscz/utils/genesis-tools/service/clients";
import { out } from "@genesiscz/utils/logger";
import type { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import { refuseHostEffectInTest } from "@genesiscz/utils/test-process";
import { type Command, Option } from "commander";

/** The service shows the request and records the person's answer itself; a click on its notification takes focus. */
async function showRequestWindow(
    client: RpcSocketClient,
    request: PersonRequest,
    fromNotification: boolean
): Promise<RequestOutcome> {
    return requestOutcomeSchema.parse(
        await client.call(
            "requests.present",
            { id: request.id, ...(fromNotification ? { takesFocus: true } : {}) },
            { timeoutMs: serviceActionClientTimeoutMs(person.actions.showWindow.timeoutMs) }
        )
    );
}

export function registerRequestCommand(program: Command): void {
    const request = program
        .command("request")
        .description("Inspect, present or withdraw a person request (every subcommand prints JSON)");
    request.command("list").action(async () => {
        const remote = await callRunningService("requests.list", {});
        out.result(remote.called ? remote.value : createRequestJournal().list({ limit: 100 }));
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
        .action(async (id: string) => {
            refuseHostEffectInTest("request worker", "Inject a worker launcher in tests.");
            const remote = await callRunningService("requests.get", { id });
            if (!(remote.called ? remote.value : createRequestJournal().get(id))) {
                throw new Error(`Request ${id} does not exist.`);
            }
            // `--` ends the options, so an id such as `--help` reaches the worker as the id.
            spawnToolDetached(["genesis-tools", "request", "run", "--from-notification", "--", id], { reparent: true });
            // The worker opens the window by itself; this command only knows that it started one.
            out.result({ id, workerStarted: true });
        });
    request
        .command("run")
        .argument("<id>")
        .addOption(new Option("--from-notification", "open the window named by a notification click").hideHelp())
        .action(async (id: string, options: { fromNotification?: boolean }) => {
            const client = await ensureGenesisToolsService();
            try {
                const view = requestViewSchema.nullable().parse(await client.call("requests.get", { id }));
                if (!view) {
                    throw new Error(`Request ${id} does not exist.`);
                }
                out.result(
                    await presentPostedRequest({
                        view,
                        journal: createRequestJournal(),
                        openWindow: options.fromNotification
                            ? (target) =>
                                  client.call<ActionOutcome<unknown>>("windows.open", target, {
                                      timeoutMs: serviceActionClientTimeoutMs(windows.actions.open.timeoutMs),
                                  })
                            : undefined,
                        showRequest: (request) => showRequestWindow(client, request, options.fromNotification === true),
                    })
                );
            } finally {
                client.close();
            }
        });
}
