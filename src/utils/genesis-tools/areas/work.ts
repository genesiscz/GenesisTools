/**
 * The `work` area (work-items P7): every method of `workApi` as an action, made by one helper from the method
 * table, so the table stays the single source. Each action has only a `native` way, which calls the work tool's door
 * (`registerWorkDoor`); a process with no door passes with the reason. A successful write emits `work.changed`.
 */
import { defineAction, defineArea } from "@genesiscz/utils/genesis-tools/actions/define";
import { type WorkMethodName, workMethods } from "@genesiscz/utils/work/api";
import { workDoor } from "@genesiscz/utils/work/door";
import { replySchemaOf } from "@genesiscz/utils/work/wire";
import { z } from "zod";

/** The per-call options of a door, one key beside the method's own params (no method has a param of that name). */
const callSchema = z
    .object({
        request: z.string().optional().describe("a request id; a repeat with the same id returns the first reply"),
        dryRun: z.boolean().optional(),
        ownerSaid: z.string().optional().describe("the owner's words, when the owner asked for this write"),
    })
    .optional();

export const workChangedSchema = z.object({
    method: z.string(),
    /** The ids the write touched, when its reply names them. */
    items: z.array(z.string()),
});

function itemsOf(data: unknown): string[] {
    const items = (data as { items?: unknown } | null)?.items;
    return Array.isArray(items)
        ? items.flatMap((item) =>
              typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []
          )
        : [];
}

function actionOf(name: WorkMethodName) {
    const method = workMethods[name];
    return defineAction({
        summary: method.doc,
        args: method.params.extend({ call: callSchema }),
        result: replySchemaOf(method.result),
        native: async (ctx) => {
            const door = workDoor();

            if (door === null) {
                return ctx.pass("the work door is not registered in this process");
            }

            const { call, ...params } = ctx.args;
            const reply = await door.call(name, params, call ?? {});

            if (reply.ok && method.effect !== "read" && call?.dryRun !== true) {
                ctx.emit("changed", { method: name, items: reply.ok ? itemsOf(reply.data) : [] });
            }

            return reply;
        },
    });
}

const actions = Object.fromEntries(
    (Object.keys(workMethods) as WorkMethodName[]).map((name) => [name, actionOf(name)])
) as { [M in WorkMethodName]: ReturnType<typeof actionOf> };

export const work = defineArea({
    area: "work",
    summary: "Work items: handoffs, tasks and spotted items of the work store",
    events: { changed: workChangedSchema },
    actions,
});

declare module "@genesiscz/utils/genesis-tools/actions/registry" {
    interface GenesisToolsAreas {
        work: typeof work;
    }
}
