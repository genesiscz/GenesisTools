import { createHash } from "node:crypto";
import { withFileLock } from "@genesiscz/utils/storage";
import type { deliverToSession } from "./deliver";
import { changeTodoAssignment, type TodoUpdateSnapshot } from "./store";

interface Assignment {
    file: string;
    events: string;
    id: string;
    expected: TodoUpdateSnapshot;
    action: "take" | "send";
    sourceHome?: string;
    afterResume?: boolean;
    signal?: AbortSignal;
    deliver?: typeof deliverToSession;
}

/** Only this task's ownership actions wait on its transport. The receiving agent can still finish it while sending. */
export function assignSessionTodo(input: Assignment) {
    const key = createHash("sha256").update(input.id).digest("hex");
    return withFileLock(`${input.file}.${key}.assignment.lock`, () => assign(input), {
        timeoutMs: 0,
        signal: input.signal,
    });
}

async function assign({ file, events, id, expected, action, sourceHome, afterResume, signal, deliver }: Assignment) {
    const assignment = { file, events, id, expected };
    if (action === "take") {
        const row = await changeTodoAssignment({
            ...assignment,
            change: (current) => ({ for: "human", state: current.state, delivery: undefined }),
        });
        return { row, needsResume: false };
    }
    // The snapshot is checked again under the decision lock before any text can be sent.
    const target = { session: expected.sessionId, provider: expected.provider, sourceHome };
    if (target.session === "local" || target.provider === "unknown") {
        throw new Error("This task has no receiving session.");
    }
    const located = deliver
        ? undefined
        : await (await import("../inbox/drafts")).waitForSessionReceiver(target, afterResume ? 30_000 : 0, { signal });
    signal?.throwIfAborted();
    const reserved = await changeTodoAssignment({
        ...assignment,
        change: (row) => {
            if (row.delivery?.uncertain || (row.for !== "human" && row.state === "acknowledged")) {
                throw new Error("This task may already have been sent. Check the session before taking it back.");
            }
            return {
                state: row.state,
                for: row.for,
                delivery: { route: "queued", at: expected.updatedTs, uncertain: true },
            };
        },
    });
    const finish = { ...assignment, reservedAt: expected.updatedTs };
    const release = () =>
        changeTodoAssignment({ ...finish, change: (row) => ({ state: row.state, for: row.for, delivery: undefined }) });
    if (!deliver && !located) {
        const row = await release();
        if (afterResume) {
            throw new Error("The resumed session did not open a receiver in 30 seconds. The task is still available.");
        }
        return { row, needsResume: true };
    }

    // A lost transport receipt keeps the durable reservation. A retry cannot send another copy.
    const send = deliver ?? (await import("./deliver")).deliverToSession;
    const result = await send({
        ...target,
        located,
        text: [`TODO ${reserved.number} (${id})`, reserved.title, reserved.prompt].filter(Boolean).join("\n"),
    });
    if (!result.delivered) {
        await release();
        throw new Error(result.error || "The session did not take the task.");
    }
    const row = await changeTodoAssignment({
        ...finish,
        change: (current) => ({
            for: "agent",
            state: current.state === "open" ? "acknowledged" : current.state,
            delivery: { route: result.channel, target: result.target, at: new Date().toISOString() },
        }),
    });
    return { row, needsResume: false };
}
