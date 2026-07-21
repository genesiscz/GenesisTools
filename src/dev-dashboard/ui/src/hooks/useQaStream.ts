import type { HandoffStreamFrame } from "@app/dev-dashboard/lib/handoff-types";
import { SafeJSON } from "@genesiscz/utils/json";
import { useEffect, useRef } from "react";

export type QaStreamQaFrame = { type: "qa"; id: string } & Record<string, unknown>;

export type QaStreamFrame = QaStreamQaFrame | HandoffStreamFrame;

type FrameHandler = (frame: QaStreamFrame) => void;
type StatusHandler = (down: boolean) => void;

const frameHandlers = new Set<FrameHandler>();
const statusHandlers = new Set<StatusHandler>();
let sharedSource: EventSource | null = null;
let refCount = 0;

function notifyStatus(down: boolean): void {
    for (const handler of statusHandlers) {
        handler(down);
    }
}

function ensureSharedSource(): void {
    if (sharedSource !== null) {
        return;
    }

    const es = new EventSource("/api/qa/stream");
    sharedSource = es;

    es.onopen = () => notifyStatus(false);
    es.onmessage = (ev) => {
        notifyStatus(false);

        try {
            const frame = SafeJSON.parse(ev.data, { strict: true }) as QaStreamFrame;

            if (frame.type !== "qa" && frame.type !== "handoff") {
                return;
            }

            for (const handler of frameHandlers) {
                handler(frame);
            }
        } catch (err) {
            console.debug("useQaStream: malformed frame", err);
        }
    };
    es.onerror = () => {
        notifyStatus(true);
    };
}

function releaseSharedSource(): void {
    if (refCount > 0 || sharedSource === null) {
        return;
    }

    sharedSource.close();
    sharedSource = null;
}

/**
 * One shared EventSource to `/api/qa/stream`. Consumers filter by `frame.type`.
 * Multiplexes QA + handoff (D7); midnight-safe on the server.
 */
export function useQaStream(
    onFrame: (frame: QaStreamFrame) => void,
    opts?: { onStatus?: (down: boolean) => void }
): void {
    const onFrameRef = useRef(onFrame);
    onFrameRef.current = onFrame;
    const onStatusRef = useRef(opts?.onStatus);
    onStatusRef.current = opts?.onStatus;

    useEffect(() => {
        const frameHandler: FrameHandler = (frame) => onFrameRef.current(frame);
        const statusHandler: StatusHandler = (down) => onStatusRef.current?.(down);

        frameHandlers.add(frameHandler);
        statusHandlers.add(statusHandler);
        refCount += 1;
        ensureSharedSource();

        return () => {
            frameHandlers.delete(frameHandler);
            statusHandlers.delete(statusHandler);
            refCount -= 1;
            releaseSharedSource();
        };
    }, []);
}
