import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { DRIVER_TIMEOUT_MS, spawnRunner } from "./runner";
import type { CommandRunner, OriginDriver, PrLookup, PrState } from "./types";

interface GhPr {
    number: number;
    state: string;
    baseRefName: string;
    url: string;
}

function toState(raw: string): PrState {
    const upper = raw.toUpperCase();
    return upper === "OPEN" || upper === "MERGED" ? upper : "CLOSED";
}

/** Pure mapping of `gh pr list --json number,state,baseRefName,url` output; open PRs win. */
export function parseGhPrList(json: string): PrLookup {
    let rows: GhPr[];

    try {
        rows = SafeJSON.parse(json, { strict: true }) as GhPr[];
    } catch (err) {
        logger.debug({ err }, "origins/gh: unparsable pr list");
        return { pr: null, error: "unparsable gh output" };
    }

    if (!Array.isArray(rows)) {
        return { pr: null, error: "gh output is not a list" };
    }

    if (rows.length === 0) {
        return { pr: null, error: null };
    }

    const valid = rows.filter(
        (r): r is GhPr =>
            typeof r?.number === "number" &&
            typeof r.state === "string" &&
            typeof r.baseRefName === "string" &&
            typeof r.url === "string"
    );

    if (valid.length === 0) {
        return { pr: null, error: "gh returned no row with number, state, baseRefName and url" };
    }

    const pick = valid.find((r) => toState(r.state) === "OPEN") ?? valid[0];
    return {
        pr: { number: pick.number, state: toState(pick.state), target: pick.baseRefName, url: pick.url },
        error: null,
    };
}

export function ghDriver(cwd: string, runner: CommandRunner = spawnRunner): OriginDriver {
    return {
        kind: "github",
        async prForHead(branch) {
            const res = await runner(
                [
                    "gh",
                    "pr",
                    "list",
                    "--head",
                    branch,
                    "--state",
                    "all",
                    "--limit",
                    "5",
                    "--json",
                    "number,state,baseRefName,url",
                ],
                { cwd, timeoutMs: DRIVER_TIMEOUT_MS }
            );

            if (res.code !== 0) {
                logger.debug({ branch, code: res.code, stderr: res.stderr }, "origins/gh: pr list failed");
                return { pr: null, error: res.stderr.trim() || `gh exited ${res.code}` };
            }

            return parseGhPrList(res.stdout);
        },
    };
}
