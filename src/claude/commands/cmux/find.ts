import { type FindOutcome, findInTranscript, type TranscriptIO } from "@app/claude/lib/cmux/transcript-find";
import { mintLink } from "@genesiscz/utils/browser-router/links";
import { routerLink } from "@genesiscz/utils/browser-router/router-link";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { runCmuxOk, sendSurfaceText } from "@genesiscz/utils/cmux/lib/cli";
import { surfaceTargetArgs } from "@genesiscz/utils/cmux/lib/target";
import { logger, out } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { activateApp, focusTarget } from "./focus";
import { locatePane } from "./read";

const { log } = logger.scoped("claude-cmux-find");

export interface FindOptions {
    decision?: string;
    at?: string | true;
    link?: boolean;
    uses?: string;
    activate?: boolean;
    first?: boolean;
    includeSelf?: boolean;
}

const MISSES: Record<Exclude<FindOutcome, { found: true }>["reason"], string> = {
    "no-transcript": "the transcript view did not open (a dialog may hold the keys); nothing was typed",
    "no-search-bar": "the transcript search bar did not open",
    "no-match": "the transcript has no such text",
    "no-result": "the search showed no result in time",
};

const AT = ["oldest", "newest"] as const;
/** The search bar takes one line; a newline or Escape in it would act as a key in the transcript view. */
const QUERY_CAP = 200;

function needle(text: string | undefined, decision: string | undefined): string {
    if (decision) {
        if (!/^\d{1,6}$/.test(decision)) {
            throw new Error(`--decision must be a number (got "${decision}")`);
        }

        return `DECISION ${decision}`;
    }

    const clean = [...(text ?? "")]
        .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
        .join("")
        .trim()
        .slice(0, QUERY_CAP);

    if (!clean) {
        throw new Error("pass the text to find, or --decision <n>");
    }

    return clean;
}

/**
 * The link instead of the search. A decision link carries no free text and routes as it is; a text link
 * is minted, because the text route shows the confirmation card for any link this Mac did not mint.
 */
async function printFindLink({
    session,
    text,
    decision,
    at,
    uses,
}: {
    session: string;
    text: string;
    decision?: string;
    at?: "oldest" | "newest";
    uses: number;
}): Promise<void> {
    const found = decision
        ? routerLink({
              preset: "claude-find",
              action: "decision",
              data: { session, decision: Number(decision), ...(at ? { at } : {}) },
              fallback: () => "",
          })
        : routerLink({
              preset: "claude-find",
              action: "text",
              data: { session, q: text, ...(at ? { at } : {}) },
              fallback: () => "",
          });

    if (!found.link) {
        throw new Error(`no find link on this Mac: ${found.error?.message} (${found.error?.reason})`);
    }

    const label = decision ? `show DECISION ${decision} in chat` : `show "${text}" in chat`;

    if (decision) {
        out.println(`[${label}](${found.link})`);
        return;
    }

    const host = new URL(found.link).host;
    const minted = await mintLink({ target: found.link, uses, label, linkHost: host });
    out.println(minted.markdown);
}

/**
 * Searches the session's transcript view while its tab stays where it is, and raises the tab only
 * after a hit, so a miss never moves the user's cmux view.
 */
export async function findCommand(session: string, text: string | undefined, opts: FindOptions): Promise<void> {
    try {
        const query = needle(text, opts.decision);
        // The router passes an absent `?at=` as "", so blank means the default.
        const at = opts.at === true || opts.at === "" ? undefined : opts.at;
        const picked = AT.find((value) => value === at);

        if (at !== undefined && !picked) {
            out.error(suggestEnumFlag("tools claude cmux find", "--at", AT, { given: at }));
            process.exitCode = 1;
            return;
        }

        if (opts.link) {
            const uses = Number(opts.uses ?? "1");

            if (!Number.isInteger(uses) || uses < 1) {
                throw new Error(`--uses must be a positive integer (got "${opts.uses}")`);
            }

            await printFindLink({ session, text: query, decision: opts.decision, at: picked, uses });
            return;
        }

        // A decision is found where it was first asked; a re-ask further down only names it.
        const oldest = picked === undefined ? Boolean(opts.decision) : picked === "oldest";
        const located = await locatePane(session, { first: opts.first, includeSelf: opts.includeSelf }, {});

        if (!located) {
            return;
        }

        const where = surfaceTargetArgs(located.surfaceId, located.target.workspaceId);
        const io: TranscriptIO = {
            screen: async () => (await runCmuxOk(["read-screen", ...where])).stdout,
            key: async (name) => {
                await runCmuxOk(["send-key", ...where, name]);
            },
            text: async (value) => {
                await sendSurfaceText({ surfaceRef: located.surfaceId, text: value });
            },
            sleep: (ms) => Bun.sleep(ms),
        };
        const outcome = await findInTranscript(io, { query, oldest });
        log.debug({ session, query, oldest, surface: located.surfaceId, outcome }, "transcript search");

        if (!outcome.found) {
            out.error(pc.red(`"${query}" not shown: ${MISSES[outcome.reason]}.`));
            process.exitCode = 1;
            return;
        }

        await focusTarget({ ...located.target, surfaceId: located.surfaceId });

        if (opts.activate !== false) {
            await activateApp();
        }

        out.println(
            `${pc.green("✓")} "${query}" match ${outcome.current}/${outcome.total} in ${located.target.workspaceName}` +
                pc.dim(" (q or Esc leaves the transcript view, n/N steps through matches)")
        );
    } catch (error) {
        out.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
