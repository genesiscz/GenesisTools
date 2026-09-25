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

/** The PR/MR head branch shown on the page; a fork's `owner:branch` loses the owner. */
export function headBranch(doc: Document): string | undefined {
    const candidates = [
        doc.querySelector(".js-source-branch-copy")?.getAttribute("data-clipboard-text"),
        doc.querySelector("[data-testid='head-ref'], .head-ref")?.textContent,
        doc.querySelector(".ref-container .ref-name")?.textContent,
    ];

    for (const raw of candidates) {
        const branch = raw?.trim().replace(/^[^:\s]+:/, "");

        if (branch && BRANCH_HINT.test(branch)) {
            return branch;
        }
    }

    return undefined;
}
