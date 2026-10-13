import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeployedFile } from "../deployed.ts";
import { lineColumnAt } from "../source-map.ts";
import { excerptOf, loadMap, offsetOf, outsideFile } from "./shared.ts";
import type { ResolveRequest, ResolverAttempt, SourceResolver } from "./types.ts";

/**
 * The fast, exact path: the deployment published a map (or inlined one) for this file.
 * Needs a snapshot from `snapshotDeployment`, which already fetched every referenced map.
 */
export class DeployedMapResolver implements SourceResolver {
    readonly name = "deployed-map";

    constructor(private readonly snapshot: { dir: string; files: DeployedFile[] }) {}

    async resolve(request: ResolveRequest): Promise<ResolverAttempt> {
        const file = this.snapshot.files.find((candidate) => candidate.url === request.url.split("#")[0]);
        if (!file) {
            return { resolver: this.name, result: null, reason: "the URL is not part of the deployment snapshot" };
        }

        if (!file.mapPath) {
            return { resolver: this.name, result: null, reason: `no published map (${file.mapStatus ?? "unknown"})` };
        }

        const code = await readFile(join(this.snapshot.dir, file.path), "utf8");
        const map = await loadMap(join(this.snapshot.dir, file.mapPath));
        const offset = offsetOf(code, request.position);
        if (offset < 0) {
            return outsideFile(this.name, file.path, code);
        }

        const position = map.originalPositionFor(lineColumnAt(code, offset));
        if (!position) {
            return { resolver: this.name, result: null, reason: "the published map has no segment at that position" };
        }

        return {
            resolver: this.name,
            result: {
                ...position,
                resolver: this.name,
                confidence: "exact",
                excerpt: excerptOf(map, position),
                evidence: [`published map ${file.mapStatus === "inline" ? "(inline)" : file.mapPath}`],
                warnings: [],
            },
        };
    }
}
