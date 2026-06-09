import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { SignalEvent } from "./types";

export interface NotifyOpts {
    say?: boolean;
    exec?: string;
}

type Spawner = (cmd: string[], env?: Record<string, string>) => void;

const defaultSpawner: Spawner = (cmd, env) => {
    try {
        Bun.spawn(cmd, {
            env: { ...process.env, ...(env ?? {}) },
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
        }).unref();
    } catch (err) {
        logger.warn({ err, cmd: cmd[0] }, "tradingview: notify spawn failed");
    }
};

export function notifySignal(
    event: SignalEvent,
    symbol: string,
    opts: NotifyOpts,
    spawner: Spawner = defaultSpawner
): void {
    if (opts.say) {
        const short = symbol.includes(":") ? symbol.split(":")[1] : symbol;
        spawner(["tools", "say", `${short} ${event.plotTitle} signal`, "--app", "tradingview"]);
    }

    if (opts.exec) {
        spawner(["sh", "-c", opts.exec], { TV_SIGNAL: SafeJSON.stringify({ ...event, symbol }, { strict: true }) });
    }
}
