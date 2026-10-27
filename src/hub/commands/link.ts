import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import { resolveCommitLink } from "../lib/commit-link";

/** `tools hub link <sha|a..b>`: the hub link for a commit, inside the PR that holds it, else inside its project. */
export function registerLinkCommand(program: Command): void {
    program
        .command("link")
        .description(
            "Print the hub link for a commit or a range: inside the PR or MR the forge says holds it (GitHub commits/{sha}/pulls, GitLab repository/commits/{sha}/merge_requests), else inside its project. Agents: write commit links with this, never by hand"
        )
        .argument("<commit>", "a commit (7 to 40 hex characters) or <from>..<to>")
        .option(
            "--repo <path|owner/repo>",
            "the checkout, or the forge project under the repo roots (default: this folder's)"
        )
        .option("--json", "machine-readable output: { link, query, pr, candidates, pushed, notes, … }")
        .option("--fresh", "ask the forge again instead of reusing its answer from the last minutes")
        .action(async (spec: string, opts: { repo?: string; json?: boolean; fresh?: boolean }) => {
            let resolved: Awaited<ReturnType<typeof resolveCommitLink>>;

            try {
                resolved = await resolveCommitLink({ spec, repo: opts.repo, cache: !opts.fresh });
            } catch (error) {
                out.log.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
                return;
            }

            if (opts.json) {
                out.result(resolved);
                return;
            }

            out.println(resolved.link);
            const pr = resolved.pr;
            const place = pr
                ? `${pr.ref} (${pr.title}), ${pr.state.toLowerCase()}${pr.merge ? ", its merge commit" : pr.holds === false ? ", which no longer holds it (rewritten)" : ""}`
                : resolved.pushed === false
                  ? `no PR: the forge does not have ${resolved.spec} (not pushed)`
                  : `no PR holds ${resolved.spec}`;
            out.log.info(pc.dim(place));

            for (const note of resolved.notes) {
                out.log.warn(note);
            }
        });
}
