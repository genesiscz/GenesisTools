import { abortableSleep } from "@genesiscz/utils/async";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { runAx } from "../runner";
import type { ObservationChangeSource } from "./await";
import type { ControlDriver } from "./native";
import type { Observation } from "./observation";

export class NativeObservationSource implements ObservationChangeSource {
    readonly kind = "AXObserver-with-snapshot-fallback";
    constructor(private readonly driver: ControlDriver) {}
    async next(call: { previous: Observation; signal: AbortSignal; timeoutMs: number }): Promise<Observation | null> {
        call.signal.throwIfAborted();
        const clock = new Stopwatch();
        const timeoutMs = Math.min(1000, Math.floor(call.timeoutMs));
        const args = [
            "wait-change",
            "--app",
            String(call.previous.pid),
            "--window-id",
            String(call.previous.window.id),
            "--timeout-ms",
            String(Math.max(1, timeoutMs)),
        ];
        if (call.previous.processLaunch !== undefined) {
            args.push("--launch", String(call.previous.processLaunch));
        }
        const event = runAx(args, Math.max(1, Math.floor(call.timeoutMs)));
        call.signal.throwIfAborted();
        let remaining = call.timeoutMs - clock.elapsedMs;
        if (remaining <= 0) {
            return null;
        }
        if (!event.ok) {
            throw new Error(event.error ?? "Native observation wake failed.");
        }
        const delay =
            event.supported === true ? (event.events === 0 ? 0 : 100) : Math.max(0, timeoutMs - clock.elapsedMs);
        if (delay > 0) {
            await abortableSleep(Math.min(delay, remaining), call.signal);
        }
        remaining = call.timeoutMs - clock.elapsedMs;
        return remaining <= 0
            ? null
            : this.driver.observe({ signal: call.signal, timeoutMs: Math.min(10000, remaining) });
    }
}
