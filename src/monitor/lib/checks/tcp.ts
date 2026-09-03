import { logger } from "@genesiscz/utils/logger";
import type { CheckResult, Watcher } from "../types";

export interface HostPort {
    host: string;
    port: number;
}

/** `host:port`, `[v6]:port` or a URL; the port is required. */
export function parseHostPort(target: string, defaultPort?: number): HostPort {
    const trimmed = target.trim().replace(/^[a-z]+:\/\//i, "");
    const bracket = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);

    if (bracket) {
        const port = bracket[2] ? Number(bracket[2]) : defaultPort;

        if (!port) {
            throw new Error("port is required");
        }

        return { host: bracket[1], port };
    }

    const lastColon = trimmed.lastIndexOf(":");
    const host = lastColon >= 0 ? trimmed.slice(0, lastColon) : trimmed;
    const portText = lastColon >= 0 ? trimmed.slice(lastColon + 1).replace(/\/.*$/, "") : "";
    const port = portText ? Number(portText) : defaultPort;

    if (!host) {
        throw new Error("host is required");
    }

    if (!port || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("port must be 1..65535");
    }

    return { host: host.replace(/\/.*$/, ""), port };
}

/** Opens a TCP connection and closes it again: the port answers, or it does not. */
export async function checkTcp(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    let hostPort: HostPort;

    try {
        hostPort = parseHostPort(watcher.target);
    } catch (error) {
        return {
            status: "unknown",
            latencyMs: null,
            httpStatus: null,
            detail: `bad target: ${(error as Error).message}`,
        };
    }

    const started = performance.now();
    const label = `${hostPort.host}:${hostPort.port}`;

    return new Promise<CheckResult>((resolve) => {
        let settled = false;
        const finish = (result: CheckResult) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(result);
            }
        };
        const timer = setTimeout(() => {
            finish({
                status: "down",
                latencyMs: null,
                httpStatus: null,
                detail: `${label}: no connection within ${Math.round(watcher.timeoutMs / 1000)} s`,
            });
        }, watcher.timeoutMs);

        Bun.connect({
            hostname: hostPort.host,
            port: hostPort.port,
            socket: {
                open(socket) {
                    const latencyMs = Math.round(performance.now() - started);
                    socket.end();
                    const threshold = watcher.config.degradedAboveMs;

                    if (threshold !== undefined && latencyMs > threshold) {
                        finish({
                            status: "degraded",
                            latencyMs,
                            httpStatus: null,
                            detail: `${label} open · ${latencyMs} ms (slower than ${threshold} ms)`,
                        });

                        return;
                    }

                    finish({ status: "up", latencyMs, httpStatus: null, detail: `${label} open · ${latencyMs} ms` });
                },
                connectError(_socket, error) {
                    logger.debug({ error, target: watcher.target }, "monitor: tcp connect failed");
                    finish({ status: "down", latencyMs: null, httpStatus: null, detail: `${label}: ${error.message}` });
                },
                error(_socket, error) {
                    logger.debug({ error, target: watcher.target }, "monitor: tcp socket error");
                    finish({ status: "down", latencyMs: null, httpStatus: null, detail: `${label}: ${error.message}` });
                },
                data() {},
                close() {},
            },
        }).catch((error: unknown) => {
            finish({
                status: "down",
                latencyMs: null,
                httpStatus: null,
                detail: `${label}: ${error instanceof Error ? error.message : String(error)}`,
            });
        });
    });
}
