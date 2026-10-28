import { spawnRunner } from "@genesiscz/utils/git/origins/runner";
import type { CommandRunner } from "@genesiscz/utils/git/origins/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { cached } from "@genesiscz/utils/storage/cache-flag";
import { Storage } from "@genesiscz/utils/storage/storage";

/** The `--include` name that adds `gh pr checks` (each check's own words, a re-run counted once) to the answer. */
export const CHECKS_FIELD = "checks";
const GH_TIMEOUT_MS = 15_000;

/** One PR's chosen fields, or `pr: null` when GitHub has no PR for the input. */
export interface PrFieldsAnswer {
    pr: Record<string, unknown> | null;
    checks?: unknown[];
}

const storage = new Storage("github");

/** The repository a bare number or branch belongs to: `--repo`, else the folder's `origin`, else the folder itself. */
async function repoKey(cwd: string, repo: string | undefined, run: CommandRunner): Promise<string> {
    if (repo) {
        return repo;
    }

    const origin = await run(["git", "remote", "get-url", "origin"], { cwd, timeoutMs: 5_000 });

    return origin.code === 0 && origin.stdout.trim() ? origin.stdout.trim() : cwd;
}

/**
 * `gh pr view <input> --json <fields>` (and `gh pr checks` for `checks`), served from a cache every caller on this
 * Mac shares when it is at most `maxCacheAgeSeconds` old. The input is a number, a URL or a branch, as gh takes it.
 * A failure other than "no PR" (network, auth) throws and is not stored.
 */
export async function readPrFields({
    input,
    fields,
    cwd,
    repo,
    maxCacheAgeSeconds,
    run = spawnRunner,
}: {
    input: string;
    fields: readonly string[];
    cwd: string;
    repo?: string;
    maxCacheAgeSeconds?: number;
    run?: CommandRunner;
}): Promise<{ value: PrFieldsAnswer; hit: boolean }> {
    const wanted = [...new Set(fields)].sort();
    const withChecks = wanted.includes(CHECKS_FIELD);
    const viewFields = wanted.filter((field) => field !== CHECKS_FIELD);

    if (withChecks && !viewFields.includes("number")) {
        viewFields.push("number");
    }

    const owner = await repoKey(cwd, repo, run);
    const key = `pr-fields/${Bun.hash(SafeJSON.stringify({ owner, input, wanted })).toString(16)}.json`;
    const repoArgs = repo ? ["--repo", repo] : [];

    return cached<PrFieldsAnswer>({
        storage,
        key,
        maxAgeSeconds: maxCacheAgeSeconds,
        shareInFlight: `github/${key}`,
        fetch: async () => {
            const view = await run(["gh", "pr", "view", input, ...repoArgs, "--json", viewFields.join(",")], {
                cwd,
                timeoutMs: GH_TIMEOUT_MS,
            });

            if (view.code !== 0) {
                if (/no pull requests? found|could not resolve to a pull ?request/i.test(view.stderr)) {
                    return { pr: null };
                }

                throw new Error(`gh pr view ${input} failed (exit ${view.code}): ${view.stderr.trim()}`);
            }

            const pr: unknown = SafeJSON.parse(view.stdout, { strict: true });

            if (typeof pr !== "object" || pr === null || Array.isArray(pr)) {
                throw new Error(`gh pr view ${input} answered no object`);
            }

            const answer: PrFieldsAnswer = { pr: Object.fromEntries(Object.entries(pr)) };

            if (withChecks && typeof answer.pr?.number === "number") {
                // `gh pr checks` exits 1 with a failed check and 8 with a pending one, so only its output counts.
                const checks = await run(
                    [
                        "gh",
                        "pr",
                        "checks",
                        /^https?:\/\//i.test(input) ? input : String(answer.pr.number),
                        ...repoArgs,
                        "--json",
                        "name,description,link,bucket",
                    ],
                    { cwd, timeoutMs: GH_TIMEOUT_MS }
                );
                if (![0, 1, 8].includes(checks.code) || !checks.stdout.trim().startsWith("[")) {
                    throw new Error(`gh pr checks ${input} failed (exit ${checks.code}): ${checks.stderr.trim()}`);
                }

                const parsed: unknown = SafeJSON.parse(checks.stdout, { strict: true });

                if (!Array.isArray(parsed)) {
                    throw new Error(`gh pr checks ${input} answered no array`);
                }

                answer.checks = parsed;
            }

            return answer;
        },
    });
}
