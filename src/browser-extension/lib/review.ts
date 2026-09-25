import { logger } from "@genesiscz/utils/logger";
import { startSession } from "./agent";
import type { Deps } from "./deps";
import { FeatureError } from "./errors";
import { type PageRequest, resolveRequest } from "./open";
import type { ForgePage } from "./page-url";

export interface ReviewGate {
    /** `tools hub status` exited 0: the review window is installed. */
    hub: boolean;
    /** The facts command exists (`tools gitlab pr review` for GitLab; always true for GitHub). */
    facts: boolean;
    /** Why the review cannot start; null when both gates pass. */
    reason: string | null;
}

export interface ReviewPlan {
    url: string;
    root: string;
    gate: ReviewGate;
    prompt: string;
}

const log = logger.child({ component: "browser-extension/review" });

export function reviewUrl(page: ForgePage): string {
    return page.kind === "github"
        ? `${page.webBase}/pull/${page.number}`
        : `${page.webBase}/-/merge_requests/${page.number}`;
}

/**
 * The agent's task. Built only from parsed, validated parts of the URL (never from page text), and
 * it forbids posting: every comment waits in the review window for the user.
 */
export function reviewPrompt(page: ForgePage, root: string): string {
    const n = page.number;
    const facts =
        page.kind === "gitlab"
            ? [
                  `\`tools gitlab pr review ${n} --json\` (diff hunks, checklist, related MRs)`,
                  `\`tools gitlab fetch-review ${n}\` (existing threads with the code at each anchor)`,
              ]
            : [`\`tools github review ${n} --llm\` (existing threads)`, `\`tools github pr ${n}\` (details)`];
    const noun = page.kind === "gitlab" ? `merge request !${n}` : `pull request #${n}`;
    const forge = page.kind === "gitlab" ? "GitLab" : "GitHub";

    return [
        `# Review ${noun}`,
        "",
        `- Page: ${reviewUrl(page)}`,
        `- Project: ${page.host}/${page.project}`,
        `- Local checkout: ${root}`,
        "",
        `Review this ${noun} with the gt:review-proposal skill.`,
        "",
        "1. Gate: `tools hub status --json` must exit 0.",
        `2. Facts, run in this checkout: ${facts.join("; ")}.`,
        "3. Make sure the checkout has both the base and the head commit (`git fetch origin <source-branch>`).",
        "4. Write the proposal JSON and push it with `tools hub proposal push <file> --open`.",
        "",
        `Never post, approve or merge anything on ${forge}. Every comment waits in the review window, where the user decides.`,
        "",
    ].join("\n");
}

export async function reviewGate(deps: Deps, page: ForgePage, root: string): Promise<ReviewGate> {
    const hub = await deps.tools(["hub", "status", "--json"], { cwd: root, timeoutMs: 15_000 });
    const hubOk = hub.code === 0;
    let factsOk = true;

    if (page.kind === "gitlab") {
        // Commander answers `--help` for an unknown subcommand with the ROOT usage and exit 0, so
        // only the command's own usage line proves it exists.
        const help = await deps.tools(["gitlab", "pr", "review", "--help"], { cwd: root, timeoutMs: 15_000 });
        factsOk = help.code === 0 && /Usage: gitlab pr review\b/.test(help.stdout);
    }

    const reason = !hubOk
        ? "The GenesisTools.app review window is not installed (tools hub status exits 1)."
        : !factsOk
          ? "tools gitlab pr review is not available yet, so the review has no MR facts to start from."
          : null;
    log.info({ hub: hubOk, facts: factsOk, kind: page.kind }, "review gate");
    return { hub: hubOk, facts: factsOk, reason };
}

export async function planReview(deps: Deps, request: PageRequest): Promise<ReviewPlan> {
    const resolved = await resolveRequest(deps, request);

    if (resolved.page.view !== "pr" || !resolved.page.number) {
        throw new FeatureError("invalid", "not a pull request or merge request page");
    }

    const root = resolved.checkout.root;
    return {
        url: reviewUrl(resolved.page),
        root,
        gate: await reviewGate(deps, resolved.page, root),
        prompt: reviewPrompt(resolved.page, root),
    };
}

/** Opens an agent session that runs the review-proposal flow; refuses with the gate's reason. */
export async function startReview(deps: Deps, request: PageRequest) {
    const plan = await planReview(deps, request);

    if (plan.gate.reason) {
        throw new FeatureError("unavailable", plan.gate.reason);
    }

    const session = await startSession({
        deps,
        config: await deps.config(),
        cwd: plan.root,
        title: `review ${plan.url.split("/").at(-1)}`,
        kind: "review",
        prompt: plan.prompt,
    });
    return { url: plan.url, root: plan.root, ...session };
}
