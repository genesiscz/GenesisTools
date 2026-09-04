import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { DRIVER_TIMEOUT_MS, spawnRunner } from "./runner";
import type { CommandRunner, OriginDriver, PrLookup, PrState } from "./types";

interface GlabMr {
    iid: number;
    state: string;
    target_branch: string;
    web_url: string;
}

/** GitLab says `opened`/`merged`/`closed`/`locked`; a locked MR is still open for our purposes. */
function toState(raw: string): PrState {
    const lower = raw.toLowerCase();

    if (lower === "opened" || lower === "locked") {
        return "OPEN";
    }

    return lower === "merged" ? "MERGED" : "CLOSED";
}

/**
 * Pure mapping of `glab mr list --output json` output; open MRs win. The
 * `--output json` form is used because the human table truncates branch
 * names.
 */
export function parseGlabMrList(json: string): PrLookup {
    let rows: GlabMr[];

    try {
        rows = SafeJSON.parse(json, { strict: true }) as GlabMr[];
    } catch (err) {
        logger.debug({ err }, "origins/glab: unparsable mr list");
        return { pr: null, error: "unparsable glab output" };
    }

    if (!Array.isArray(rows)) {
        return { pr: null, error: "glab output is not a list" };
    }

    if (rows.length === 0) {
        return { pr: null, error: null };
    }

    const valid = rows.filter(
        (r): r is GlabMr =>
            typeof r?.iid === "number" &&
            typeof r.state === "string" &&
            typeof r.target_branch === "string" &&
            typeof r.web_url === "string"
    );

    if (valid.length === 0) {
        return { pr: null, error: "glab returned no row with iid, state, target_branch and web_url" };
    }

    const pick = valid.find((r) => toState(r.state) === "OPEN") ?? valid[0];
    return {
        pr: { number: pick.iid, state: toState(pick.state), target: pick.target_branch, url: pick.web_url },
        error: null,
    };
}

export function glabDriver(cwd: string, runner: CommandRunner = spawnRunner): OriginDriver {
    return {
        kind: "gitlab",
        async prForHead(branch) {
            const res = await runner(["glab", "mr", "list", "--source-branch", branch, "--all", "--output", "json"], {
                cwd,
                timeoutMs: DRIVER_TIMEOUT_MS,
            });

            if (res.code !== 0) {
                logger.debug({ branch, code: res.code, stderr: res.stderr }, "origins/glab: mr list failed");
                return { pr: null, error: res.stderr.trim() || `glab exited ${res.code}` };
            }

            return parseGlabMrList(res.stdout);
        },
    };
}
