import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { parseSync } from "oxc-parser";
import { git } from "./build.ts";
import type { DeployedFile } from "./deployed.ts";
import { repoPathsFor } from "./repo-paths.ts";
import { localMapPath } from "./resolvers/shared.ts";

const prof = profiler.scope("sourcemaps");

const { log } = logger.scoped("ts:sourcemaps:token-rank");

/** Token -> how often it occurs. Keys are `s:<string text>` or `p:<property or key name>`. */
export type TokenBag = Map<string, number>;

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const LOCKFILE = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

interface EstreeNode {
    type: string;
    [key: string]: unknown;
}

function isNode(value: unknown): value is EstreeNode {
    return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function add(bag: TokenBag, kind: "s" | "p", text: string): void {
    // A minifier turns `a["name"]` into `a.name` and `{"name":1}` into `{name:1}`, so an identifier-shaped
    // string is counted as a name on both sides.
    const key = kind === "s" && IDENTIFIER.test(text) ? `p:${text}` : `${kind}:${text}`;
    bag.set(key, (bag.get(key) ?? 0) + 1);
}

/**
 * The tokens of JavaScript that survive minification unchanged: string literal and template text, and
 * non-computed member and object-key names. Mangled locals, numbers (rewritten as `1e3`), module specifiers
 * (rewritten as module ids) and directives are left out.
 */
export function survivorTokens(code: string, filename = "chunk.js"): TokenBag {
    const bag: TokenBag = new Map();
    const parsed = parseSync(filename, code, { sourceType: "unambiguous" });
    const stack: Array<{ node: EstreeNode; parent: EstreeNode | null; key: string }> = [
        { node: parsed.program as unknown as EstreeNode, parent: null, key: "" },
    ];
    while (stack.length > 0) {
        const { node, parent, key } = stack.pop() as { node: EstreeNode; parent: EstreeNode | null; key: string };
        if (key === "source" && parent && /^(Import|Export|ImportExpression)/.test(parent.type)) {
            continue;
        }

        if (
            key === "arguments" &&
            parent?.type === "CallExpression" &&
            isNode(parent.callee) &&
            parent.callee.type === "Identifier" &&
            parent.callee.name === "require"
        ) {
            continue;
        }

        if (node.type === "ExpressionStatement" && typeof node.directive === "string") {
            continue;
        }

        if (node.type === "Literal" && typeof node.value === "string" && node.value.length >= 2) {
            add(bag, "s", node.value);
        } else if (node.type === "TemplateElement") {
            const cooked = (node.value as { cooked?: string | null } | undefined)?.cooked ?? "";
            if (cooked.length >= 2) {
                add(bag, "s", cooked);
            }
        } else if (node.type === "MemberExpression" && !node.computed && isNode(node.property)) {
            if (node.property.type === "Identifier" && typeof node.property.name === "string") {
                add(bag, "p", node.property.name);
            }
        } else if (node.type === "Property" && !node.computed && isNode(node.key) && node.key.type === "Identifier") {
            if (typeof node.key.name === "string") {
                add(bag, "p", node.key.name);
            }
        }

        for (const [childKey, value] of Object.entries(node)) {
            if (childKey === "type" || childKey === "start" || childKey === "end") {
                continue;
            }

            if (Array.isArray(value)) {
                for (const child of value) {
                    if (isNode(child)) {
                        stack.push({ node: child, parent: node, key: childKey });
                    }
                }
            } else if (isNode(value)) {
                stack.push({ node: value, parent: node, key: childKey });
            }
        }
    }

    return bag;
}

/** Survivor tokens of a source file as a bundler would emit it: TypeScript and JSX are transpiled first. */
export function sourceFileTokens(code: string, path: string): TokenBag {
    const ext = /\.([cm]?[jt]sx?)$/.exec(path)?.[1] ?? "js";
    const loader = ext.endsWith("tsx") ? "tsx" : ext.endsWith("ts") ? "ts" : ext.endsWith("jsx") ? "jsx" : "js";
    try {
        const js = new Bun.Transpiler({ loader, target: "browser" }).transformSync(code);
        return survivorTokens(js, "source.js");
    } catch (err) {
        log.debug({ path, err }, "transpile failed; file counted as empty");
        return new Map();
    }
}

/** Token counts over every JS file of a build or a deployment. */
export async function bundleTokens(dir: string, files: string[]): Promise<TokenBag> {
    const stopProfile = prof.start("tokens.bundle");
    try {
        const total: TokenBag = new Map();
        for (const file of files) {
            const code = await readFile(join(dir, file), "utf8");
            for (const [key, count] of survivorTokens(code, file.replace(/\.m?js$/, ".js"))) {
                total.set(key, (total.get(key) ?? 0) + count);
            }
        }

        return total;
    } finally {
        stopProfile();
    }
}

/** Repo paths the build's maps name: the files that end up in the bundle. */
export async function bundledRepoPaths(options: {
    buildDir: string;
    files: string[];
    tracked: string[];
    preferDir?: string;
}): Promise<Set<string>> {
    const paths = new Set<string>();
    for (const file of options.files) {
        const code = await readFile(join(options.buildDir, file), "utf8");
        const mapPath = await localMapPath(options.buildDir, file, code);
        if (!mapPath) {
            continue;
        }

        const map = SafeJSON.parse(await readFile(mapPath, "utf8"), { strict: true }) as { sources?: unknown };
        const sources = Array.isArray(map.sources) ? map.sources.filter((s): s is string => typeof s === "string") : [];
        for (const source of sources) {
            if (source.includes("node_modules/")) {
                continue;
            }

            for (const path of repoPathsFor({ source, tracked: options.tracked, preferDir: options.preferDir })) {
                paths.add(path);
            }
        }
    }

    return paths;
}

export interface TokenRank {
    commit: string;
    /** Sum over the discriminating tokens of |deployed count - predicted count|. Lower is better; 0 is a perfect fit. */
    error: number;
    /** Bundled source files that differ between this commit and the reference. */
    changedFiles: number;
    /** A lockfile differs from the reference, so dependency code may differ in ways the ranking cannot see. */
    lockfileDiffers: boolean;
}

export interface TokenRanking {
    ranking: TokenRank[];
    /** Tokens whose count some candidate changes and that occur in either bundle. */
    tokens: number;
    bundledFiles: number;
    /** For the best candidate: the tokens still off, worst first. */
    residual: Array<{ token: string; deployed: number; predicted: number }>;
    notes: string[];
}

async function lsTree(repo: string, commit: string, paths: string[]): Promise<Map<string, string>> {
    const blobs = new Map<string, string>();
    for (let i = 0; i < paths.length; i += 200) {
        const output = await git(repo, ["ls-tree", "-r", commit, "--", ...paths.slice(i, i + 200)]);
        for (const line of output.split("\n").filter(Boolean)) {
            const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
            if (match) {
                blobs.set(match[2], match[1]);
            }
        }
    }

    return blobs;
}

/**
 * Ranks candidate commits by how well each explains the deployed bundle, using ONE reference build and no build
 * per candidate. Minifiers keep string text and property names, so the deployed count of such a token is the
 * reference build's count plus the change of every bundled source file between the reference and the candidate.
 * The candidate whose predicted counts fit the deployment best is the deployed commit (or an equivalent one).
 */
export async function rankCommitsByTokens(options: {
    repo: string;
    deployed: { dir: string; files: DeployedFile[] };
    reference: { dir: string; files: string[]; commit: string };
    /** Candidate commits, newest first (the order ties are reported in). */
    candidates: string[];
    preferDir?: string;
}): Promise<TokenRanking> {
    const stopProfile = prof.start("tokens.rank");
    try {
        const notes: string[] = [];
        const deployedBag = await bundleTokens(
            options.deployed.dir,
            options.deployed.files.map((file) => file.path)
        );
        const referenceBag = await bundleTokens(options.reference.dir, options.reference.files);
        const trackedAtReference = (await git(options.repo, ["ls-tree", "-r", "--name-only", options.reference.commit]))
            .split("\n")
            .filter(Boolean);
        const trackedSet = new Set(trackedAtReference);
        const bundled = await bundledRepoPaths({
            buildDir: options.reference.dir,
            files: options.reference.files,
            tracked: trackedAtReference,
            preferDir: options.preferDir,
        });
        if (bundled.size === 0) {
            notes.push("the reference build has no source maps naming repo files, so no commit can be ranked");
        }

        const bundledDirs = new Set([...bundled].map((path) => dirname(path)));
        const isBundled = (path: string) =>
            SOURCE_FILE.test(path) && (bundled.has(path) || (!trackedSet.has(path) && bundledDirs.has(dirname(path))));

        const blobBags = new Map<string, TokenBag>();
        const bagOfBlob = async (blob: string | undefined, path: string): Promise<TokenBag> => {
            if (!blob) {
                return new Map();
            }

            let bag = blobBags.get(blob);
            if (!bag) {
                bag = sourceFileTokens(await git(options.repo, ["cat-file", "-p", blob]), path);
                blobBags.set(blob, bag);
            }

            return bag;
        };

        const deltas = new Map<string, { delta: TokenBag; changedFiles: number; lockfileDiffers: boolean }>();
        for (const commit of options.candidates) {
            if (commit === options.reference.commit) {
                deltas.set(commit, { delta: new Map(), changedFiles: 0, lockfileDiffers: false });
                continue;
            }

            const changed = (
                await git(options.repo, ["diff", "--name-only", "--no-renames", commit, options.reference.commit])
            )
                .split("\n")
                .filter(Boolean);
            const files = changed.filter(isBundled);
            const atCandidate = await lsTree(options.repo, commit, files);
            const atReference = await lsTree(options.repo, options.reference.commit, files);
            const delta: TokenBag = new Map();
            for (const path of files) {
                for (const [token, count] of await bagOfBlob(atCandidate.get(path), path)) {
                    delta.set(token, (delta.get(token) ?? 0) + count);
                }

                for (const [token, count] of await bagOfBlob(atReference.get(path), path)) {
                    delta.set(token, (delta.get(token) ?? 0) - count);
                }
            }

            deltas.set(commit, {
                delta,
                changedFiles: files.length,
                lockfileDiffers: changed.some((path) => LOCKFILE.test(path)),
            });
        }

        // Only tokens that some candidate moves AND that occur in either bundle can tell candidates apart; the rest
        // are names the bundler rewrote (imports, JSX runtime calls) and would add the same noise to every candidate.
        const discriminating = new Set<string>();
        for (const { delta } of deltas.values()) {
            for (const [token, count] of delta) {
                if (count !== 0 && (deployedBag.has(token) || referenceBag.has(token))) {
                    discriminating.add(token);
                }
            }
        }

        // A token no candidate can bring close to its deployed count was changed by the build environment, not by a
        // commit (a release snippet in every chunk, an inlined env value); it would only add slope to the errors.
        const environmental: Array<{ token: string; offset: number }> = [];
        for (const token of discriminating) {
            const offset = (deployedBag.get(token) ?? 0) - (referenceBag.get(token) ?? 0);
            const moves = [...deltas.values()].map(({ delta }) => delta.get(token) ?? 0);
            const spread = Math.max(0, ...moves) - Math.min(0, ...moves);
            const closest = Math.min(...moves.map((move) => Math.abs(offset - move)));
            if (closest > spread) {
                environmental.push({ token, offset });
                discriminating.delete(token);
            }
        }

        if (environmental.length > 0) {
            environmental.sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
            notes.push(
                `${environmental.length} token(s) differ in a way no candidate explains (build environment, ignored): ${environmental
                    .slice(0, 4)
                    .map((entry) => `${entry.token.slice(0, 30)} ${entry.offset > 0 ? "+" : ""}${entry.offset}`)
                    .join(", ")}`
            );
        }

        const errorOf = (delta: TokenBag) => {
            let error = 0;
            for (const token of discriminating) {
                const predicted = (referenceBag.get(token) ?? 0) + (delta.get(token) ?? 0);
                error += Math.abs((deployedBag.get(token) ?? 0) - predicted);
            }

            return error;
        };

        const ranking: TokenRank[] = options.candidates.map((commit) => {
            const entry = deltas.get(commit) ?? { delta: new Map(), changedFiles: 0, lockfileDiffers: false };
            return {
                commit,
                error: errorOf(entry.delta),
                changedFiles: entry.changedFiles,
                lockfileDiffers: entry.lockfileDiffers,
            };
        });
        const order = new Map(options.candidates.map((commit, index) => [commit, index]));
        ranking.sort((a, b) => a.error - b.error || (order.get(a.commit) ?? 0) - (order.get(b.commit) ?? 0));

        const residual: TokenRanking["residual"] = [];
        const best = ranking[0] ? deltas.get(ranking[0].commit) : undefined;
        if (best) {
            for (const token of discriminating) {
                const predicted = (referenceBag.get(token) ?? 0) + (best.delta.get(token) ?? 0);
                const deployed = deployedBag.get(token) ?? 0;
                if (deployed !== predicted) {
                    residual.push({ token, deployed, predicted });
                }
            }

            residual.sort((a, b) => Math.abs(b.deployed - b.predicted) - Math.abs(a.deployed - a.predicted));
        }

        log.info(
            {
                candidates: ranking.length,
                tokens: discriminating.size,
                bundled: bundled.size,
                best: ranking[0]?.commit,
            },
            "token ranking done"
        );
        return {
            ranking,
            tokens: discriminating.size,
            bundledFiles: bundled.size,
            residual: residual.slice(0, 12),
            notes,
        };
    } finally {
        stopProfile();
    }
}
