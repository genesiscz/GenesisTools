import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { ContainerInfo, ContainersResult } from "./types";

interface DockerPsRow {
    ID?: string;
    Names?: string;
    Image?: string;
    State?: string;
    Status?: string;
    Ports?: string;
}

export function parseDockerPsJsonl(stdout: string): ContainerInfo[] {
    const containers: ContainerInfo[] = [];

    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        let row: DockerPsRow;
        try {
            row = SafeJSON.parse(trimmed, { jsonl: true, strict: true, unbox: true }) as DockerPsRow;
        } catch (err) {
            logger.warn({ err, line: trimmed }, "docker ps: skipping malformed JSONL line");
            continue;
        }

        containers.push({
            id: row.ID ?? "",
            name: row.Names ?? "",
            image: row.Image ?? "",
            state: (row.State ?? "").toLowerCase(),
            status: row.Status ?? "",
            ports: row.Ports ?? "",
        });
    }

    return containers;
}

/**
 * `docker ps` against a wedged daemon never returns, and /api/containers is a
 * public route: without this the front proxy's own deadline turned it into a
 * 15 s 502 with a `docker` process left behind on every reload.
 */
const DOCKER_PS_TIMEOUT_MS = 8_000;

export async function listContainers(): Promise<ContainersResult> {
    try {
        const proc = Bun.spawn(["docker", "ps", "-a", "--format", "{{json .}}"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const killer = setTimeout(() => {
            logger.warn({ timeoutMs: DOCKER_PS_TIMEOUT_MS }, "docker ps timed out; killing it");
            proc.kill();
        }, DOCKER_PS_TIMEOUT_MS);

        try {
            await proc.exited;
        } finally {
            clearTimeout(killer);
        }

        if (proc.exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            logger.warn(
                { exitCode: proc.exitCode, stderr },
                "docker ps exited non-zero; treating Docker as unavailable"
            );
            return { dockerAvailable: false, containers: [] };
        }

        const stdout = await new Response(proc.stdout).text();
        return { dockerAvailable: true, containers: parseDockerPsJsonl(stdout) };
    } catch (err) {
        logger.debug({ err }, "docker ps spawn failed; treating Docker as unavailable");
        return { dockerAvailable: false, containers: [] };
    }
}
