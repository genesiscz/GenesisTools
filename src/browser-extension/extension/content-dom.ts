import type { HostResponse } from "../lib/host/messages";
import type { MenuMessage } from "./shared/bridge";

/**
 * Best-effort reads of GitHub and GitLab markup: which file and line an element belongs to, and
 * the head branch of a PR/MR page. Both sites change their markup, so every reader tries several
 * shapes and returns undefined rather than guessing. The host re-validates everything.
 */

const PATH_ATTRIBUTES = ["data-tagsearch-path", "data-path", "data-file-path", "data-new-path"];
const BRANCH_HINT = /^[A-Za-z0-9._/-]{1,200}$/;

export interface DomContext {
    path?: string;
    line?: number;
}

function attributeUp(el: Element | null, names: readonly string[]): string | undefined {
    for (let node = el; node; node = node.parentElement) {
        for (const name of names) {
            const value = node.getAttribute(name);

            if (value) {
                return value;
            }
        }
    }

    return undefined;
}

/** The file of the diff or blob that contains `el`. */
export function pathAt(el: Element | null): string | undefined {
    const direct = attributeUp(el, PATH_ATTRIBUTES);

    if (direct) {
        return direct;
    }

    // Newer GitHub diff views keep the path on the file header, a sibling above the rows.
    const file = el?.closest("[id^='diff-'], .file, .diff-file, [data-testid*='diff']");
    const header = file?.querySelector(PATH_ATTRIBUTES.map((name) => `[${name}]`).join(", "));
    return header ? attributeUp(header, PATH_ATTRIBUTES) : undefined;
}

function positive(value: string | null | undefined): number | undefined {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The new-side line number of the diff row (or blob line) that contains `el`. */
export function lineAt(el: Element | null): number | undefined {
    const row = el?.closest("tr, .line_holder, [data-line-number], .react-code-line, [id^='LC']");

    if (!row) {
        return undefined;
    }

    const gitlabNew = row.querySelector(".new_line [data-linenumber], .new_line[data-linenumber]");
    const fromGitlab = positive(gitlabNew?.getAttribute("data-linenumber"));

    if (fromGitlab) {
        return fromGitlab;
    }

    const numbered = [row, ...row.querySelectorAll("[data-line-number]")]
        .map((node) => positive(node.getAttribute("data-line-number")))
        .filter((n): n is number => n !== undefined);

    if (numbered.length > 0) {
        return numbered[numbered.length - 1];
    }

    const anchor = /^(?:LC|L)(\d+)$/.exec(row.id) ?? /R(\d+)$/.exec(row.id);
    return positive(anchor?.[1]);
}

export function contextAt(el: Element | null): DomContext {
    return { path: pathAt(el), line: lineAt(el) };
}

/**
 * The head branch in the data GitHub's React PR page ships with its HTML
 * (`script[data-target="react-app.embeddedData"]`, `"headBranch":"feat/x"`). That script can
 * outlive an in-page navigation to another PR, so it counts only when it names this PR's number.
 */
export function headBranchFromEmbeddedData(text: string | null | undefined, number?: number): string | undefined {
    if (!text || (number !== undefined && !text.includes(`"number":${number},`))) {
        return undefined;
    }

    return text.match(/"headBranch":"([^"\\]{1,200})"/)?.[1];
}

/**
 * The PR/MR head branch shown on the page; a fork's `owner:branch` loses the owner. The React PR
 * page (2026) renders base and head as two `PullRequestBranchName-module__…` links, base first.
 */
export function headBranch(doc: Document, number?: number): string | undefined {
    const branchLinks = doc.querySelectorAll("a[class*='PullRequestBranchName'][href*='/tree/']");
    const embedded = doc.querySelector("script[data-target='react-app.embeddedData']")?.textContent;
    const candidates = [
        headBranchFromEmbeddedData(embedded, number),
        doc.querySelector(".js-source-branch-copy")?.getAttribute("data-clipboard-text"),
        doc.querySelector("[data-testid='head-ref'], .head-ref")?.textContent,
        doc.querySelector(".ref-container .ref-name")?.textContent,
        branchLinks.length >= 2 ? branchLinks[1]?.textContent : undefined,
    ];

    for (const raw of candidates) {
        const branch = raw?.trim().replace(/^[^:\s]+:/, "");

        if (branch && BRANCH_HINT.test(branch)) {
            return branch;
        }
    }

    return undefined;
}

/**
 * The page element a menu entry acts on: the last right-clicked one for a menu click, nothing for
 * the keyboard shortcut (a right-click from minutes ago must not turn Alt+Shift+G into "open that file").
 */
export function menuTargetContext<T>(message: MenuMessage, read: () => T, empty: T): T {
    return message.source === "shortcut" ? empty : read();
}

/**
 * "Does this project have a local checkout?", asked once per project while the answer is definite.
 * Only a definite "no checkout" hides the dock; a host that is down or failed still shows it (a click
 * explains what is wrong), and that answer is not kept, so the next render asks again.
 */
export function checkoutCache(probe: (webBase: string) => Promise<HostResponse>): CheckoutCache {
    const known = new Map<string, Promise<boolean>>();
    /** Projects whose held answer is "no checkout": a focus asks them again (`recheck`). */
    const absent = new Set<string>();

    const ask = (webBase: string) => {
        let answer = known.get(webBase);

        if (!answer) {
            answer = probe(webBase).then(
                (reply) => {
                    if (!reply.ok && reply.code !== "no-checkout") {
                        known.delete(webBase);
                        return true;
                    }

                    if (!reply.ok) {
                        absent.add(webBase);
                    }

                    return reply.ok;
                },
                (error: unknown) => {
                    // A probe that throws is as transient as a host that is down: show, and ask again.
                    console.warn("[genesis-tools] checkout probe failed", error);
                    known.delete(webBase);
                    return true;
                }
            );
            known.set(webBase, answer);
        }

        return answer;
    };

    // Held or in flight; false after a transient answer, which the caller asks again on a focus.
    // A held "no checkout" is dropped by `recheck`: cloning the project, mapping it in `repos` or fixing
    // its remote brought the dock back only after a reload of the tab (2026-10-04).
    return Object.assign(ask, {
        answered: (webBase: string) => known.has(webBase),
        recheck: (webBase: string) => {
            if (!absent.delete(webBase)) {
                return false;
            }

            known.delete(webBase);
            return true;
        },
    });
}

export type CheckoutCache = ((webBase: string) => Promise<boolean>) & {
    /** A definite answer is held (or a probe is in flight) for `webBase`; false when the next render should ask. */
    answered(webBase: string): boolean;
    /** Drops a held "no checkout" for `webBase` so the next render asks again; true when there was one. */
    recheck(webBase: string): boolean;
};

/** Where keyboard focus goes when the dock disappears under it: the page's main landmark, else the body. */
export function pageFocusTarget<
    T extends { hasAttribute(name: string): boolean; setAttribute(name: string, value: string): void },
>(doc: { querySelector(selector: string): T | null; body: T }): T {
    const main = doc.querySelector("main, [role='main']");

    if (!main) {
        return doc.body;
    }

    // A landmark takes focus only with a tabindex; -1 keeps it out of the tab order.
    if (!main.hasAttribute("tabindex")) {
        main.setAttribute("tabindex", "-1");
    }

    return main;
}

/** The parts of the result card the auto-close rule reads. */
export interface CardPresence<T> {
    contains(node: T | null): boolean;
    matches(selector: string): boolean;
}

/**
 * A quick result closes itself only while nobody uses it: focus inside the card, or a pointer over
 * it, keeps it open until it is closed by hand, so a keyboard user can read it.
 */
export function quickCardMayClose<T>(card: CardPresence<T>, focused: T | null): boolean {
    return !card.contains(focused) && !card.matches(":hover");
}

/**
 * Focus is inside a surface about to be replaced. The dock is rebuilt on every toggle, so the focused
 * button goes with the old surface; the caller then focuses the new toggle, and a keyboard user stays
 * in the toolbar. `focused` is the dock's shadow root's `activeElement`, which sees inside it.
 */
export function surfaceHoldsFocus<T>(
    surface: { contains(node: T | null): boolean } | null,
    focused: T | null
): boolean {
    return surface !== null && focused !== null && surface.contains(focused);
}
