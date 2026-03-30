import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DockerContainer, type DockerProgressCallback } from "./docker-container";

const QDRANT_IMAGE = "qdrant/qdrant:v1.17.0";
const QDRANT_CONTAINER_NAME = "genesis-tools-qdrant";
const QDRANT_PORT = parseInt(process.env.GENESIS_QDRANT_PORT || "16335", 10);
const QDRANT_GRPC_PORT = parseInt(process.env.GENESIS_QDRANT_GRPC_PORT || "16336", 10);
const QDRANT_STORAGE = join(homedir(), ".genesis-tools", "indexes", "qdrant");

let instance: DockerContainer | null = null;

export function getQdrantContainer(): DockerContainer {
    if (instance) {
        return instance;
    }

    mkdirSync(QDRANT_STORAGE, { recursive: true });

    instance = new DockerContainer({
        name: QDRANT_CONTAINER_NAME,
        image: QDRANT_IMAGE,
        ports: [
            { host: QDRANT_PORT, container: 6333 },
            { host: QDRANT_GRPC_PORT, container: 6334 },
        ],
        volumes: [{ host: QDRANT_STORAGE, container: "/qdrant/storage" }],
        healthUrl: `http://localhost:${QDRANT_PORT}/healthz`,
        restartPolicy: "unless-stopped",
    });

    return instance;
}

export async function ensureQdrantReady(
    onProgress?: DockerProgressCallback,
): Promise<{ started: boolean; pulled: boolean }> {
    return getQdrantContainer().ensureReady(onProgress);
}

export function getQdrantUrl(): string {
    return `http://localhost:${QDRANT_PORT}`;
}
