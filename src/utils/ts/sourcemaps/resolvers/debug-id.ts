import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { type DebugIdMapSource, debugIdOf } from "../debug-id.ts";
import type { DeployedFile } from "../deployed.ts";
import { lineColumnAt, SourceMapIndex } from "../source-map.ts";
import { excerptOf, offsetOf, outsideFile } from "./shared.ts";
import type { ResolveRequest, ResolverAttempt, SourceResolver } from "./types.ts";

/**
 * The exact map of a deployed file, found by the debug id the file carries (`//# debugId=` or Sentry's
 * `sentry-dbid-<uuid>`), from sources the caller configured: a folder of maps, or Sentry's artifact lookup.
 * Optional by design: it only runs when a source is given, after the deployment's own published maps.
 */
export class DebugIdResolver implements SourceResolver {
    readonly name = "debug-id";
    private readonly maps = new Map<string, { map: SourceMapIndex; source: string }>();

    constructor(
        private readonly deployed: { dir: string; files: DeployedFile[] },
        private readonly sources: DebugIdMapSource[],
        /** Called once per map a source returned, e.g. to keep it so the next run does not download it again. */
        private readonly onMap?: (debugId: string, text: string, source: string) => Promise<void>
    ) {}

    private async mapOf(debugId: string, reasons: string[]): Promise<{ map: SourceMapIndex; source: string } | null> {
        const known = this.maps.get(debugId);
        if (known) {
            return known;
        }

        for (const source of this.sources) {
            let text: string | null;
            try {
                text = await source.mapFor(debugId);
            } catch (err) {
                reasons.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }

            if (!text) {
                reasons.push(`${source.name}: no map for ${debugId}`);
                continue;
            }

            // Parse before onMap keeps it: a kept invalid map would be the first source asked on every later run.
            let map: SourceMapIndex;
            try {
                map = SourceMapIndex.parse(SafeJSON.parse(text, { strict: true }));
            } catch (err) {
                reasons.push(`${source.name}: not a usable map (${err instanceof Error ? err.message : String(err)})`);
                continue;
            }

            await this.onMap?.(debugId, text, source.name);
            const found = { map, source: source.name };
            this.maps.set(debugId, found);
            return found;
        }

        return null;
    }

    async resolve(request: ResolveRequest): Promise<ResolverAttempt> {
        const file = this.deployed.files.find((candidate) => candidate.url === request.url.split("#")[0]);
        if (!file) {
            return { resolver: this.name, result: null, reason: "the URL is not part of the deployment snapshot" };
        }

        const code = await readFile(join(this.deployed.dir, file.path), "utf8");
        const debugId = debugIdOf(code);
        if (!debugId) {
            return {
                resolver: this.name,
                result: null,
                reason: "the file carries no debug id (no //# debugId comment, no sentry-dbid snippet)",
            };
        }

        const reasons: string[] = [];
        const found = await this.mapOf(debugId, reasons);
        if (!found) {
            return { resolver: this.name, result: null, reason: reasons.join("; ") || `no source has ${debugId}` };
        }

        const offset = offsetOf(code, request.position);
        if (offset < 0) {
            return outsideFile(this.name, file.path, code);
        }

        const position = found.map.originalPositionFor(lineColumnAt(code, offset));
        if (!position) {
            return { resolver: this.name, result: null, reason: `the map for ${debugId} has no segment there` };
        }

        return {
            resolver: this.name,
            result: {
                ...position,
                resolver: this.name,
                confidence: "exact",
                excerpt: excerptOf(found.map, position),
                evidence: [`debug id ${debugId}`, `map from ${found.source}`],
                warnings: [],
            },
        };
    }
}
