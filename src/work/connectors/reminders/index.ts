/**
 * The reminders connector: a todo item becomes one Reminders.app entry through the todo tool's own sync code
 * (`syncTodo`), so `tools todo add --sync-to reminders` and a push make the same entry. It makes entries and never
 * reads them back.
 */
// lint-rules-ignore: the reminders connector is the todo tool's sync code behind the connector interface (P5 decision 1)
import { TodoStore } from "@app/todo/lib/store";
// lint-rules-ignore: the reminders connector is the todo tool's sync code behind the connector interface (P5 decision 1)
import { syncTodo } from "@app/todo/lib/sync";
import type { Connector, PushResult } from "@genesiscz/utils/work/connectors/types";
import { z } from "zod";

export const remindersSettings = z.object({}).passthrough();

export const remindersConnector: Connector<unknown> = {
    id: "reminders",
    settings: remindersSettings,
    can: { create: true, pull: false, labels: false, comments: false, parents: false },

    async status() {
        return { ok: process.platform === "darwin", detail: "Reminders.app through EventKit" };
    },

    async push(intents) {
        const results: PushResult[] = [];

        for (const intent of intents) {
            if (intent.item.type !== "todo") {
                results.push({ ok: false, error: `only a todo goes to Reminders, not a ${intent.item.type}` });
                continue;
            }

            const found = (await TodoStore.findByItem(intent.item.id)) ?? TodoStore.adoptWorkTodo(intent.item.id);

            if (found === null) {
                results.push({ ok: false, error: `Todo ${intent.item.id} is missing or dropped` });
                continue;
            }

            const store = TodoStore.forProject(found.projectRoot);
            const result = await syncTodo({
                store,
                todo: found.todo,
                target: "reminders",
                reminderId: intent.pairing?.remoteKey || undefined,
            });
            const outcome = result.reminders;
            results.push(
                outcome?.ok === true
                    ? { ok: true, remoteKey: outcome.id }
                    : {
                          ok: false,
                          error: outcome?.ok === false ? outcome.error.message : "Reminders answered nothing",
                          ...(outcome?.id ? { remoteKey: outcome.id } : {}),
                      }
            );
        }

        return results;
    },

    async pull() {
        return [];
    },
};
