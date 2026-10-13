import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { alignOffset, type NormalizedCode, normalizeIdentifiers } from "../align.ts";
import { git } from "../build.ts";
import type { DeployedFile } from "../deployed.ts";
import { LineTranslator } from "../line-translate.ts";
import { chunkKey, chunkSimilarity, type Similarity } from "../pair.ts";
import { pairFilesByContent } from "../pair-content.ts";
import { repoPathsFor } from "../repo-paths.ts";
import { lineColumnAt } from "../source-map.ts";
import { excerptOf, literalTokenAt, loadMap, localMapPath, offsetOf, snapToToken } from "./shared.ts";
import type { ResolveRequest, ResolverAttempt, SourceResolver } from "./types.ts";

export interface LocalBuild {
    /** Folder with the build output (JS next to its `.map` files). */
    dir: string;
    /** Relative JS paths inside `dir` (see `listJsFiles`). */
    files: string[];
    /** How to name this build in evidence lines, e.g. `build ce35b47b5b7d`. */
    label: string;
    /** The commit the build was made from, when known: lets lines be translated to the deployed commit. */
    commit?: string;
}

export interface LocalBuildResolverOptions {
    /** The git checkout both commits live in. */
    repo?: string;
    /** The commit the deployment was built from (from find-commit, or known). Lines are reported for it. */
    deployedCommit?: string;
    /** Folder whose files are preferred when a map source name matches several repo paths. */
    preferDir?: string;
}

/**
 * Carries the deployed position into a local build of (ideally) the same commit: identifiers are
 * collapsed in both texts, a code window around the position must occur once in the local file, and the
 * local `.map` answers. Works when the two builds mangle names differently or one has an injected banner.
 */
const NEIGHBOR_DISTANCE = 300;

/**
 * A unique window can still sit in code that changed around it. The window 300 characters before and after the
 * position must land the same distance away in the local build (within 25%: mangled names differ in length),
 * or the answer is only approximate.
 */
export function neighborsAgree(options: {
    deployed: { raw: string; normalized: NormalizedCode };
    local: { raw: string; normalized: NormalizedCode };
    offset: number;
    alignedOffset: number;
}): { agree: boolean; side: "before" | "after" | "around" } {
    const failing: Array<"before" | "after"> = [];
    for (const direction of [-1, 1] as const) {
        const neighbor = options.offset + direction * NEIGHBOR_DISTANCE;
        if (neighbor < 0 || neighbor >= options.deployed.raw.length) {
            continue;
        }

        const aligned = alignOffset({
            from: options.deployed.normalized,
            to: options.local.normalized,
            offset: neighbor,
        });
        const distance = direction * (aligned.offset - options.alignedOffset);
        if (
            aligned.confidence !== "unique" ||
            distance < 0.75 * NEIGHBOR_DISTANCE ||
            distance > 1.25 * NEIGHBOR_DISTANCE
        ) {
            failing.push(direction < 0 ? "before" : "after");
        }
    }

    if (failing.length === 0) {
        return { agree: true, side: "around" };
    }

    return { agree: false, side: failing.length === 2 ? "around" : failing[0] };
}

export class LocalBuildResolver implements SourceResolver {
    readonly name = "local-build";
    private localByDeployed: Promise<Map<string, string>> | null = null;
    private readonly normalized = new Map<string, Promise<{ raw: string; normalized: NormalizedCode }>>();
    private readonly similarity = new Map<string, Similarity>();
    private readonly translator: LineTranslator | null;
    private tracked: Promise<string[]> | null = null;

    constructor(
        private readonly deployed: { dir: string; files: DeployedFile[] },
        private readonly build: LocalBuild,
        private readonly options: LocalBuildResolverOptions = {}
    ) {
        this.translator =
            options.repo && options.deployedCommit && build.commit && options.deployedCommit !== build.commit
                ? new LineTranslator({ repo: options.repo, from: build.commit, to: options.deployedCommit })
                : null;
    }

    /** The build's source line, moved to the deployed commit's version of the file. */
    private async translateLine(
        source: string,
        line: number
    ): Promise<{ line: number; changed: boolean; path: string } | null> {
        if (!this.translator || !this.options.repo || !this.build.commit) {
            return null;
        }

        const repo = this.options.repo;
        const commit = this.build.commit;
        this.tracked ??= git(repo, ["ls-tree", "-r", "--name-only", commit]).then((out) =>
            out.split("\n").filter(Boolean)
        );
        const [path] = repoPathsFor({ source, tracked: await this.tracked, preferDir: this.options.preferDir });
        if (!path) {
            return null;
        }

        const translated = await this.translator.translate(path, line);
        return translated ? { ...translated, path } : null;
    }

    /** Deployed path to local path, by name and, where names are only hashes, by content. Made once. */
    private pairing(): Promise<Map<string, string>> {
        this.localByDeployed ??= pairFilesByContent({
            deployedDir: this.deployed.dir,
            deployed: this.deployed.files.filter((file) => /\.m?js$/.test(file.path)).map((file) => file.path),
            localDir: this.build.dir,
            local: this.build.files,
        }).then((pairing) => new Map(pairing.pairs.map((pair) => [pair.deployed, pair.local])));
        return this.localByDeployed;
    }

    private read(path: string): Promise<{ raw: string; normalized: NormalizedCode }> {
        let loaded = this.normalized.get(path);
        if (!loaded) {
            loaded = readFile(path, "utf8").then((raw) => ({ raw, normalized: normalizeIdentifiers(raw) }));
            this.normalized.set(path, loaded);
        }

        return loaded;
    }

    async resolve(request: ResolveRequest): Promise<ResolverAttempt> {
        const file = this.deployed.files.find((candidate) => candidate.url === request.url.split("#")[0]);
        if (!file) {
            return { resolver: this.name, result: null, reason: "the URL is not part of the deployment snapshot" };
        }

        const localPath = (await this.pairing()).get(file.path);
        if (!localPath) {
            return {
                resolver: this.name,
                result: null,
                reason: `${this.build.label} has no file matching ${chunkKey(file.path)} by name or content (the chunk may not exist at that commit)`,
            };
        }

        const deployed = await this.read(join(this.deployed.dir, file.path));
        const local = await this.read(join(this.build.dir, localPath));
        const offset = offsetOf(deployed.raw, request.position);
        if (offset < 0 || offset >= deployed.raw.length) {
            return {
                resolver: this.name,
                result: null,
                reason: `the position is outside ${file.path} (${deployed.raw.length} characters)`,
            };
        }

        const aligned = alignOffset({ from: deployed.normalized, to: local.normalized, offset });
        if (aligned.offset < 0) {
            return {
                resolver: this.name,
                result: null,
                reason: `no code window around offset ${offset} exists in ${localPath} (injected or changed code)`,
            };
        }

        const mapPath = await localMapPath(this.build.dir, localPath, local.raw);
        if (!mapPath) {
            return { resolver: this.name, result: null, reason: `${localPath} was built without a source map` };
        }

        const map = await loadMap(mapPath);
        const mapped = map.originalPositionFor(lineColumnAt(local.raw, aligned.offset));
        if (!mapped) {
            return { resolver: this.name, result: null, reason: `${localPath}.map has no segment there` };
        }

        const token = literalTokenAt(deployed.raw, offset);
        const snapped = token ? snapToToken({ map, position: mapped, token }) : null;
        const position = snapped ?? mapped;

        let similarity = this.similarity.get(file.path);
        if (!similarity) {
            similarity = chunkSimilarity(deployed.raw, local.raw);
            this.similarity.set(file.path, similarity);
        }

        const warnings: string[] = [];
        if (similarity.rate < 0.999) {
            warnings.push(
                `${(100 * (1 - similarity.rate)).toFixed(1)}% of this chunk's code differs from ${this.build.label} (another commit, or build-time values)`
            );
        }

        if (aligned.confidence === "nearest") {
            warnings.push(
                `${aligned.candidates} places match the code window; the one nearest the expected position was used`
            );
        }

        const surroundings = neighborsAgree({ deployed, local, offset, alignedOffset: aligned.offset });
        if (!surroundings.agree) {
            warnings.push(
                `the code ${surroundings.side} this position differs from ${this.build.label}, so the line may belong to changed code; build the deployed commit for an exact answer`
            );
        }

        const excerpt = excerptOf(map, position);
        const translation: string[] = [];
        let reported = position;
        let lineChanged = false;
        const translated = await this.translateLine(position.source, position.line);
        if (translated && this.options.deployedCommit && this.build.commit) {
            const target = this.options.deployedCommit.slice(0, 12);
            reported = { ...position, line: translated.line };
            translation.push(
                `line ${position.line} at ${this.build.commit.slice(0, 12)} is line ${translated.line} at ${target} (git diff of ${translated.path})`
            );
            if (translated.changed) {
                lineChanged = true;
                warnings.push(
                    `this line was edited between ${this.build.commit.slice(0, 12)} and ${target}; the deployed line is where that edit starts`
                );
            }
        } else if (this.translator) {
            warnings.push(
                "the file could not be followed to the deployed commit (renamed, deleted or outside the repo); the line is the build's"
            );
        }

        return {
            resolver: this.name,
            result: {
                ...reported,
                resolver: this.name,
                confidence:
                    aligned.confidence === "unique" && surroundings.agree && !lineChanged ? "aligned" : "approximate",
                excerpt,
                evidence: [
                    `${this.build.label}: ${localPath}`,
                    `${aligned.windowChars}-char code window, ${aligned.candidates} match`,
                    `chunk similarity ${(100 * similarity.rate).toFixed(2)}%`,
                    ...translation,
                    ...(snapped
                        ? [
                              `map segment pointed at line ${mapped.line}; moved to line ${snapped.line}, where '${token}' is`,
                          ]
                        : []),
                ],
                warnings,
            },
        };
    }
}
