import { type ActionRecordingSnapshot, startActionRecording } from "@app/chrome-devtools/lib/action-recording";
import { waitForPath } from "@genesiscz/utils/fs/watcher";
import { logger } from "@genesiscz/utils/logger";
import { type BugRecording, httpUrl, parseRecording } from "./types";
import { saveRecording } from "./workspace";

export function recordingSnapshot(options: {
    snapshot: ActionRecordingSnapshot;
    id: string;
    title: string;
}): BugRecording {
    const validUrl = (value: string | undefined) => {
        try {
            httpUrl(value);
            return true;
        } catch (error) {
            logger.debug({ error }, "non-HTTP recorded URL retained as evidence only");
            return false;
        }
    };
    const initialUrl = new URL(options.snapshot.initialUrl);
    initialUrl.username = "";
    initialUrl.password = "";
    return {
        version: 1,
        id: options.id,
        title: options.title,
        ...options.snapshot,
        initialUrl: httpUrl(initialUrl.toString()),
        actions: options.snapshot.actions
            .filter((action) => action.kind !== "navigate" || validUrl(action.url))
            .map((action) =>
                action.sourceUrl === undefined || validUrl(action.sourceUrl)
                    ? action
                    : { ...action, sourceUrl: undefined }
            ),
    };
}

export async function recordBug(options: {
    port: number;
    targetId: string;
    output: string;
    stopPath: string;
    title: string;
    seconds: number;
    signal: AbortSignal;
}): Promise<BugRecording> {
    if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 600) {
        throw new Error("Recording deadline must be between 1 and 600 seconds.");
    }
    const id = crypto.randomUUID();
    const build = (snapshot: ActionRecordingSnapshot) => recordingSnapshot({ snapshot, id, title: options.title });
    let checkpoint: BugRecording | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingSave = Promise.resolve();
    const recorder = await startActionRecording({
        port: options.port,
        targetId: options.targetId,
        signal: options.signal,
        maxSeconds: options.seconds,
        onUpdate: (snapshot) => {
            checkpoint = build(snapshot);
            if (timer === undefined) {
                timer = setTimeout(() => {
                    timer = undefined;
                    const file = checkpoint;
                    if (file) {
                        pendingSave = pendingSave
                            .then(() => saveRecording({ path: options.output, recording: file }))
                            .catch((error) => {
                                logger.warn({ error }, "browser recording checkpoint could not be saved");
                            });
                    }
                }, 250);
            }
        },
    });
    try {
        await saveRecording({ path: options.output, recording: build(recorder.snapshot()) });
        await waitForPath(options.stopPath, { timeoutMs: options.seconds * 1000, signal: options.signal });
    } finally {
        const snapshot = await recorder.stop();
        clearTimeout(timer);
        await pendingSave;
        await saveRecording({ path: options.output, recording: build(snapshot) });
    }
    return parseRecording(build(recorder.snapshot()));
}
