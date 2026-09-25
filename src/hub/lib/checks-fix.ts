import { logger } from "@genesiscz/utils/logger";
import { type CheckLogResult, checkFixMarkdown, checkFixPrompt, checkLog } from "./checks";
import { type FixThreadsDeps, type FixThreadsResult, prLabel, realFixThreadsDeps, sendPrTask } from "./fix-threads";

// "Send to agent" on a failed check: the failing log goes into a task file for the session that owns
// the PR's branch, through the same path as "Fix these threads" (`sendPrTask`).

const log = logger.child({ component: "hub/checks-fix" });

export interface FixCheckInput {
    /** The checkout of the PR. */
    repo: string;
    /** The PR's URL or `<repoPath>#<n>`; default: the branch's PR at `repo`. */
    pr?: string;
    checkUrl: string;
    checkName: string;
    session?: string;
    dryRun?: boolean;
    send?: boolean;
    focus?: boolean;
    activate?: boolean;
}

export interface FixCheckDeps extends FixThreadsDeps {
    log: (url: string) => Promise<CheckLogResult>;
}

export const realFixCheckDeps: FixCheckDeps = { ...realFixThreadsDeps, log: (url) => checkLog({ url }) };

/** The same result shape as `fix-threads` (no threads), so the hub decodes both with one type. */
export async function fixCheck(input: FixCheckInput, deps: FixCheckDeps = realFixCheckDeps): Promise<FixThreadsResult> {
    // The PR first, the log second: a ref the host does not know stops here, before the log's own
    // host call, so the window-argv fixture test and a typo in `--pr` cost no request.
    const pr = await deps.pr({ repo: input.repo, pr: input.pr });
    const result = await deps.log(input.checkUrl);
    const label = prLabel(pr);
    log.debug(
        { pr: pr.url, check: input.checkName, sections: result.sections.length, error: result.error },
        "fix check"
    );
    const task = await sendPrTask(
        {
            repo: input.repo,
            pr,
            markdown: checkFixMarkdown({
                checkName: input.checkName,
                prLabel: label,
                prUrl: pr.webUrl || pr.url,
                branch: pr.sourceBranch,
                result,
            }),
            prompt: (file) => checkFixPrompt({ file, checkName: input.checkName, prLabel: label }),
            what: `check ${input.checkName}`,
            session: input.session,
            dryRun: input.dryRun,
            send: input.send,
            focus: input.focus,
            activate: input.activate,
        },
        deps
    );
    return { ...task, threads: [], missing: [] };
}
