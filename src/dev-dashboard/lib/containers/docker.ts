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

        const row = SafeJSON.parse(trimmed, { unbox: true }) as DockerPsRow;
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
            return { dockerAvailable: false, containers: [] };
        }

        const stdout = await new Response(proc.stdout).text();
        return { dockerAvailable: true, containers: parseDockerPsJsonl(stdout) };
    } catch {
        return { dockerAvailable: false, containers: [] };
    }
}
