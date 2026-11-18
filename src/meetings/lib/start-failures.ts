import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sendInboxMessage } from "@app/question/lib/message";
import { queryEntriesSnapshot } from "@app/question/lib/read-model";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { sendNotification } from "@genesiscz/utils/macos/notifications";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { jsonDocument } from "@genesiscz/utils/storage/locked-document";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

const { log } = logger.scoped("meetings-start");
const failureSchema = z.object({
    key: z.string(),
    meeting: z.string(),
    at: z.string(),
    problem: z.string(),
    partial: z.boolean(),
    fix: z.string(),
    inboxId: z.string().optional(),
    inboxSession: z.string().optional(),
    confirmed: z.boolean().default(false),
    attemptedAt: z.number().optional(),
});
const historySchema = z.object({ latest: z.string().optional(), failures: z.array(failureSchema) });
type Failure = z.infer<typeof failureSchema>;
export type StartProblem = Pick<Failure, "key" | "meeting" | "problem" | "partial">;

function history(store: MeetingStore) {
    return jsonDocument<z.infer<typeof historySchema>>({
        path: join(store.root, "start-failures.json"),
        empty: () => ({ failures: [] }),
        decode: (raw) => historySchema.parse(raw),
        onUnreadable: "refuse",
    });
}

export function lastStartFailure(store: MeetingStore): Failure | undefined {
    const { latest, failures } = history(store).read();
    return failures.find((row) => row.key === latest);
}

export function hasPendingStartAlerts(store: MeetingStore): boolean {
    return history(store)
        .read()
        .failures.some((row) => !row.confirmed || !row.inboxId);
}

interface Delivery {
    inbox(title: string, text: string, session: string, retry: boolean): Promise<string>;
    banner(title: string, meeting: string, text: string): Promise<boolean>;
}

export const startFailureDelivery: Delivery = {
    inbox: async (title, text, session, retry) => {
        // A crash can come after the question log append but before our receipt was saved.
        if (retry) {
            const [posted] = queryEntriesSnapshot({
                dbPath: toolDataDir("question", "qa.db"),
                opts: { sessionId: session, tag: "message", limit: 1 },
            });
            if (posted) {
                return posted.id;
            }
        }
        return (
            await sendInboxMessage({
                title,
                text,
                agentLabel: "Meetings",
                sessionHint: session,
                source: "cli",
                interrupt: false,
            })
        ).id;
    },
    banner: async (title, meeting, message) =>
        (await sendNotification({ title, subtitle: meeting, message, group: "meetings" })).confirmed,
};

/** Serialize the two delivery receipts across CLI and watcher restarts. Each channel retries independently. */
export async function deliverStartFailures(
    store: MeetingStore,
    problem?: StartProblem,
    delivery = startFailureDelivery,
    now = Date.now()
): Promise<void> {
    const doc = history(store);
    const pending = (row: Failure) =>
        (!row.inboxId || !row.confirmed) && now - (row.attemptedAt ?? -Infinity) >= 60_000;
    if (!problem && !doc.read().failures.some(pending)) {
        return;
    }

    await withFileLock(
        join(store.root, "start-failures.delivery.lock"),
        async () => {
            if (problem) {
                const incident = problem;
                const fix = /grant|permission|access|microphone|system audio/i.test(incident.problem)
                    ? toolCommand("macos", "permissions", "ui")
                    : toolCommand(
                          "meetings",
                          "record",
                          "start",
                          ...(incident.key.includes(":") ? ["--source", incident.key] : ["--meeting", incident.key])
                      );
                await doc.mutate((state) => {
                    const old = state.failures.find((row) => row.key === incident.key);
                    const details = { ...incident, at: new Date(now).toISOString(), fix };
                    if (old) {
                        Object.assign(old, details);
                    } else {
                        state.failures.push({ ...details, confirmed: false });
                    }
                    state.latest = incident.key;
                });
            }
            for (const row of doc.read().failures.filter(pending)) {
                const save = (patch: Partial<Failure>) =>
                    doc.mutate((state) => {
                        const target = state.failures.find((one) => one.key === row.key);
                        if (target) {
                            Object.assign(target, patch);
                        }
                    });
                const title = row.partial ? "Meeting recording is incomplete" : "Meeting not recorded";
                const text = `${row.meeting}: ${row.problem}${row.problem.includes(row.fix) ? "" : `\nRun: ${row.fix}`}`;
                const session = row.inboxSession ?? `meetings-recorder-${randomUUID()}`;
                await save({ attemptedAt: now, inboxSession: session });
                if (!row.inboxId) {
                    try {
                        await save({
                            inboxId: await delivery.inbox(
                                `${title}: ${row.meeting}`,
                                text,
                                session,
                                row.attemptedAt !== undefined
                            ),
                        });
                    } catch (err) {
                        log.error({ err, meeting: row.meeting }, "recording failure inbox delivery failed");
                    }
                }
                if (!row.confirmed) {
                    try {
                        const confirmed = await delivery.banner(title, row.meeting, text);
                        await save({ confirmed });
                        if (!confirmed) {
                            log.warn(
                                { meeting: row.meeting },
                                "recording failure notification delivery unconfirmed; will retry"
                            );
                        }
                    } catch (err) {
                        log.error({ err, meeting: row.meeting }, "recording failure notification failed");
                    }
                }
            }
        },
        30_000
    );
}
