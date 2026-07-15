import { type BoardEvent, subscribeBoard } from "@app/dev-dashboard/lib/boards/events";
import { createRunLogTail } from "@app/dev-dashboard/lib/daemon-run-tail";
import { classifyLogLine } from "@app/dev-dashboard/lib/daemon-view/classify";
import type { LiveHub } from "@app/dev-dashboard/lib/live/hub";
import type { LiveChannel } from "@app/dev-dashboard/lib/live/types";
import { classifyListeningPorts, listListeningPorts } from "@app/dev-dashboard/lib/ports/scanner";
import { enrichQaEntry } from "@app/dev-dashboard/lib/qa-render";
import { createQaStream, todayLogFile } from "@app/dev-dashboard/lib/qa-sse";
import { getCachedPulse, markPulseClientSeen } from "@app/dev-dashboard/lib/system/poller";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

const PORTS_INTERVAL_MS = 10_000;
const PULSE_INTERVAL_MS = 5_000;
const CLASSIFY_CHUNK = 8;

/**
 * Refcounted producers for the live hub. Starts work on 0→1 demand and stops on last unsub.
 */
export function startLiveProducers(hub: LiveHub): { stop: () => void } {
    let portsTimer: ReturnType<typeof setInterval> | null = null;
    let portsBusy = false;
    let pulseTimer: ReturnType<typeof setInterval> | null = null;
    let qaStream: ReturnType<typeof createQaStream> | null = null;
    const boardUnsubs = new Map<string, () => void>();
    const daemonTails = new Map<string, { close: () => void }>();

    async function tickPorts(): Promise<void> {
        if (portsBusy || hub.subscriberCount("ports") === 0) {
            return;
        }

        portsBusy = true;
        try {
            const result = await listListeningPorts();
            hub.publish({ v: 1, channel: "ports", type: "snapshot", payload: result });

            const pending = result.ports.filter((p) => p.probeStatus === "pending");
            for (let i = 0; i < pending.length; i += CLASSIFY_CHUNK) {
                if (hub.subscriberCount("ports") === 0) {
                    break;
                }

                const chunk = pending.slice(i, i + CLASSIFY_CHUNK);
                const updated = await classifyListeningPorts(chunk);
                if (updated.length > 0) {
                    hub.publish({ v: 1, channel: "ports", type: "classify", payload: { ports: updated } });
                }
            }
        } catch (err) {
            logger.debug({ err }, "live/producers: ports tick failed");
        } finally {
            portsBusy = false;
        }
    }

    function tickPulse(): void {
        if (hub.subscriberCount("pulse") === 0) {
            return;
        }

        markPulseClientSeen();
        const snap = getCachedPulse();
        if (snap) {
            hub.publish({ v: 1, channel: "pulse", type: "snapshot", payload: snap });
        }
    }

    function startPorts(): void {
        if (portsTimer) {
            return;
        }

        void tickPorts();
        portsTimer = setInterval(() => void tickPorts(), PORTS_INTERVAL_MS);
    }

    function stopPorts(): void {
        if (portsTimer) {
            clearInterval(portsTimer);
            portsTimer = null;
        }
    }

    function startPulse(): void {
        if (pulseTimer) {
            return;
        }

        tickPulse();
        pulseTimer = setInterval(tickPulse, PULSE_INTERVAL_MS);
    }

    function stopPulse(): void {
        if (pulseTimer) {
            clearInterval(pulseTimer);
            pulseTimer = null;
        }
    }

    function startQa(): void {
        if (qaStream) {
            return;
        }

        try {
            qaStream = createQaStream(todayLogFile(), (entry) => {
                hub.publish({
                    v: 1,
                    channel: "qa",
                    type: "entry",
                    payload: enrichQaEntry(entry),
                });
            });
        } catch (err) {
            logger.debug({ err }, "live/producers: qa stream failed to start");
        }
    }

    function stopQa(): void {
        qaStream?.close();
        qaStream = null;
    }

    function startBoard(slug: string): void {
        if (boardUnsubs.has(slug)) {
            return;
        }

        const unsub = subscribeBoard(slug, (frameJson: string) => {
            try {
                const event = SafeJSON.parse(frameJson, { strict: true }) as BoardEvent;
                hub.publish({
                    v: 1,
                    channel: `boards:${slug}`,
                    type: "event",
                    payload: event,
                });
            } catch (err) {
                logger.debug({ err, slug }, "live/producers: board frame parse failed");
            }
        });
        boardUnsubs.set(slug, unsub);
    }

    function stopBoard(slug: string): void {
        boardUnsubs.get(slug)?.();
        boardUnsubs.delete(slug);
    }

    function startDaemon(logFile: string): void {
        if (daemonTails.has(logFile)) {
            return;
        }

        try {
            const tail = createRunLogTail(logFile, (entry) => {
                hub.publish({
                    v: 1,
                    channel: `daemon:${logFile}`,
                    type: "log",
                    payload: { ...entry, cls: classifyLogLine(entry) },
                });
            });
            daemonTails.set(logFile, tail);
        } catch (err) {
            logger.debug({ err, logFile }, "live/producers: daemon tail failed to start");
        }
    }

    function stopDaemon(logFile: string): void {
        daemonTails.get(logFile)?.close();
        daemonTails.delete(logFile);
    }

    function onDemand(channel: LiveChannel, delta: 1 | -1): void {
        if (channel === "ports") {
            if (delta === 1 && hub.subscriberCount("ports") === 1) {
                startPorts();
            }

            if (delta === -1 && hub.subscriberCount("ports") === 0) {
                stopPorts();
            }

            return;
        }

        if (channel === "pulse") {
            if (delta === 1 && hub.subscriberCount("pulse") === 1) {
                startPulse();
            }

            if (delta === -1 && hub.subscriberCount("pulse") === 0) {
                stopPulse();
            }

            return;
        }

        if (channel === "qa") {
            if (delta === 1 && hub.subscriberCount("qa") === 1) {
                startQa();
            }

            if (delta === -1 && hub.subscriberCount("qa") === 0) {
                stopQa();
            }

            return;
        }

        if (channel.startsWith("boards:")) {
            const slug = channel.slice("boards:".length);
            if (delta === 1) {
                startBoard(slug);
            } else {
                // only stop when last subscriber for this exact channel is gone
                if (hub.subscriberCount(channel) === 0) {
                    stopBoard(slug);
                }
            }

            return;
        }

        if (channel.startsWith("daemon:")) {
            const logFile = channel.slice("daemon:".length);
            if (delta === 1) {
                startDaemon(logFile);
            } else if (hub.subscriberCount(channel) === 0) {
                stopDaemon(logFile);
            }
        }
    }

    const unsubDemand = hub.onDemandChange(onDemand);

    return {
        stop: () => {
            unsubDemand();
            stopPorts();
            stopPulse();
            stopQa();
            for (const slug of [...boardUnsubs.keys()]) {
                stopBoard(slug);
            }

            for (const path of [...daemonTails.keys()]) {
                stopDaemon(path);
            }
        },
    };
}
