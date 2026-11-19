import { Storage } from "@genesiscz/utils/storage";
import { z } from "zod";

function policy(show: boolean, countInBadge: boolean) {
    return z
        .object({
            show: z.boolean().default(show),
            countInBadge: z.boolean().default(countInBadge),
        })
        .prefault({});
}

const schema = z
    .object({
        decision: policy(true, true),
        form: policy(true, true),
        answer: policy(true, false),
        message: policy(true, false),
        todo: z.object({ forHuman: policy(true, false), forAgent: policy(false, false) }).prefault({}),
    })
    .prefault({});

export type InboxKinds = z.infer<typeof schema>;
export const DEFAULT_INBOX_KINDS = schema.parse(undefined);
export const kindKey = z.enum(["decision", "form", "answer", "message", "todo.forHuman", "todo.forAgent"]);
export const kindField = z.enum(["show", "countInBadge"]);

export async function readInboxKinds(storage = new Storage("hub")): Promise<InboxKinds> {
    return schema.parse(await storage.getConfigValue("inbox.kinds"));
}

export async function setInboxKind(key: string, field: string, value: boolean, storage = new Storage("hub")) {
    await storage.setConfigValue(`inbox.kinds.${kindKey.parse(key)}.${kindField.parse(field)}`, value);
    return readInboxKinds(storage);
}

export function inboxKind(
    kinds: InboxKinds,
    kind: "dialog" | "decision" | "form" | "answer" | "message" | "todo",
    owner?: string
) {
    if (kind === "todo") {
        const assigned = owner?.trim().toLowerCase();
        // Ownerless legacy tasks include composer items. Keep them visible until an assignee is recorded.
        return !assigned || assigned === "human" ? kinds.todo.forHuman : kinds.todo.forAgent;
    }
    return kinds[kind === "dialog" ? "form" : kind];
}
