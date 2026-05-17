import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
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

export async function listContainers(): Promise<ContainersResult> {
    try {
        const proc = Bun.spawn(["docker", "ps", "-a", "--format", "{{json .}}"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        await proc.exited;

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
