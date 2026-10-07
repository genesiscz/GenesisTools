/**
 * `gitlab pr`: everything about merge requests. One MR comes first, then the verb:
 *
 *   tools gitlab pr 42                         the MR: title, author, branches, state, threads, my drafts
 *   tools gitlab pr 42 review --give           facts for a review
 *   tools gitlab pr 42 comments …              threads, drafts, replies, new comments, publish
 *   tools gitlab pr 42,43 labels --add x       labels on one MR or a comma list
 *   tools gitlab pr stale preflight …          the open-MR sweep
 *   tools gitlab pr touching bun.lock          open MRs that change a file
 *
 * The CLI rewrites the public form before Commander parses it (`lib/pr-argv.ts`); every leaf that
 * acts on an MR takes it as its first argument, and its help prints the public form.
 */

import { registerLabels } from "@app/gitlab/commands/batch-label";
import { registerPrReview } from "@app/gitlab/commands/pr-review";
import { registerComments } from "@app/gitlab/commands/review-drafts";
import { registerCommentsPost, registerReviewJudgements } from "@app/gitlab/commands/review-judgements";
import { registerTouching } from "@app/gitlab/commands/search-by-file";
import { type TargetOptions, withProject } from "@app/gitlab/commands/shared";
import { registerStaleBranches } from "@app/gitlab/commands/stale-branches";
import { currentUser, resolveProjectApi } from "@app/gitlab/lib/client";
import { fetchMr } from "@app/gitlab/lib/merge-requests";
import type { CommandNode } from "@app/gitlab/lib/pr-argv";
import { fetchDiscussions, fetchDrafts } from "@app/gitlab/lib/review-drafts";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/** The leaf a bare group runs: `pr 42` → `show`, `pr 42 comments` → `comments list`, `activity user` → `events`. */
const DEFAULT_LEAF: Record<string, string> = {
    pr: "show",
    "pr comments": "list",
    "pr review": "facts",
    "activity user": "events",
};

interface ShowOptions extends TargetOptions {
    json?: boolean;
}

export function registerPr(program: Command): Command {
    const pr = program
        .command("pr")
        .description("Merge requests: gitlab pr <iid> [review|comments|labels], or gitlab pr stale|touching");

    withProject(
        pr
            .command("show")
            .description("The MR: title, author, branches, state, threads and my pending drafts")
            .argument("<iid>", "MR iid (the number after `pr`)")
            .option("--json", "Emit JSON")
    ).action(runShow);

    registerReviewJudgements(registerPrReview(pr));
    registerCommentsPost(registerComments(pr));
    registerLabels(pr);
    registerStaleBranches(pr);
    registerTouching(pr);

    return pr;
}

/** The command tree as the argv rewrite walks it (the root's own name is left out of the paths). */
export function commandTree(root: Command): CommandNode {
    const walk = (cmd: Command, path: string): CommandNode => ({
        children: new Map(
            cmd.commands.map((child) => [child.name(), walk(child, path ? `${path} ${child.name()}` : child.name())])
        ),
        defaultChild: DEFAULT_LEAF[path],
    });

    return walk(root, "");
}

/**
 * Help shows the public form: `gitlab pr <iid> comments reply [options] <thread>` rather than the
 * internal `gitlab pr comments reply [options] <iid> <thread>`.
 */
export function publicUsage(cmd: Command): string | null {
    const names: string[] = [];
    let node: Command | null = cmd;

    while (node) {
        names.unshift(node.name());
        node = node.parent;
    }

    const prAt = names.indexOf("pr");
    const [first, ...rest] = cmd.registeredArguments;
    const takesIid = (c: Command): boolean => c.registeredArguments[0]?.name() === "iid";

    // A group under `pr` whose verbs all take the MR (`pr <iid> review`, `pr <iid> comments`).
    if (prAt !== -1 && prAt < names.length - 1 && cmd.commands.length > 0 && cmd.commands.every(takesIid)) {
        return [...names.slice(0, prAt + 1), "<iid>", ...names.slice(prAt + 1), "[command]", "[options]"].join(" ");
    }

    if (prAt === -1 || first?.name() !== "iid") {
        return null;
    }

    const args = rest.map((arg) => {
        const name = `${arg.name()}${arg.variadic ? "..." : ""}`;

        return arg.required ? `<${name}>` : `[${name}]`;
    });

    return [...names.slice(0, prAt + 1), "<iid>", ...names.slice(prAt + 1), "[options]", ...args].join(" ");
}

async function runShow(iid: string, opts: ShowOptions): Promise<void> {
    if (!/^\d+$/.test(iid)) {
        throw new Error(`The MR iid must be a positive integer; got "${iid}".`);
    }

    const api = await resolveProjectApi({ host: opts.host, project: opts.project });
    const [mr, me, threads, drafts] = await Promise.all([
        fetchMr(api, Number(iid)),
        currentUser(api),
        fetchDiscussions(api, iid),
        fetchDrafts(api, iid),
    ]);
    const unresolved = threads.filter((thread) => !thread.resolved).length;

    if (opts.json) {
        out.println(
            SafeJSON.stringify(
                { ...mr, me: me.username, threads: threads.length, unresolved, myDrafts: drafts.length },
                null,
                2
            )
        );

        return;
    }

    const lines = [
        `!${mr.iid} ${mr.title}`,
        `${mr.webUrl}`,
        `@${mr.author.username}${mr.author.username === me.username ? " (you)" : ""} · ${mr.sourceBranch} → ${mr.targetBranch} · ${mr.state}${mr.draft ? " · draft" : ""} · ${mr.detailedMergeStatus}${mr.hasConflicts ? " · conflicts" : ""}`,
        `head ${mr.sha.slice(0, 10)} · updated ${mr.updatedAt}`,
        `labels: ${mr.labels.length > 0 ? mr.labels.join(", ") : "none"}`,
        `threads: ${threads.length} (${unresolved} unresolved) · my pending drafts: ${drafts.length}`,
        "",
        `Next: ${toolCommand("gitlab pr", iid, "review")} (${mr.author.username === me.username ? "--receive: the threads on your MR" : "--give: review it"})`,
    ];

    out.println(lines.join("\n"));
}
