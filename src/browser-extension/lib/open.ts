import type { LocalCheckout } from "@genesiscz/utils/git/local-checkouts";
import type { OpenResult } from "@genesiscz/utils/open-in";
import { fileInCheckout, type ResolvedPage, resolvePage } from "./checkout";
import type { Deps } from "./deps";
import { checkBranch, checkLine } from "./values";

export interface PageRequest {
    url: unknown;
    branch?: unknown;
}

export async function resolveRequest(deps: Deps, request: PageRequest): Promise<ResolvedPage> {
    const config = await deps.config();
    return resolvePage({
        url: request.url,
        branch: checkBranch(request.branch),
        config,
        checkouts: () => deps.checkouts(config),
    });
}

export interface CheckoutAnswer {
    project: string;
    webBase: string;
    view: string;
    number: number | null;
    checkouts: Pick<LocalCheckout, "root" | "branch" | "isMain">[];
}

export async function describeCheckouts(deps: Deps, request: PageRequest): Promise<CheckoutAnswer> {
    const resolved = await resolveRequest(deps, request);
    return {
        project: `${resolved.project.host}/${resolved.project.path}`,
        webBase: resolved.page.webBase,
        view: resolved.page.view,
        number: resolved.page.number ?? null,
        checkouts: resolved.candidates.map(({ root, branch, isMain }) => ({ root, branch, isMain })),
    };
}

/** Opens the page's file at its line in the configured editor; a page without a file opens the checkout. */
export async function openFile(
    deps: Deps,
    request: PageRequest & { path?: unknown; line?: unknown }
): Promise<OpenResult & { root: string; file: string | null }> {
    const config = await deps.config();
    const resolved = await resolveRequest(deps, request);
    const file = fileInCheckout(resolved, request.path);
    const line = checkLine(request.line) ?? resolved.page.line;
    const opened = await deps.editor(config.editor).open({
        root: resolved.checkout.root,
        file: file ?? undefined,
        line: file ? line : undefined,
    });
    return { ...opened, root: resolved.checkout.root, file };
}

/** A terminal at the page's checkout (the worktree on the page's branch when there is one). */
export async function openTerminal(deps: Deps, request: PageRequest): Promise<OpenResult & { root: string }> {
    const config = await deps.config();
    const resolved = await resolveRequest(deps, request);
    const opened = await deps.terminal(config.terminal).open({
        cwd: resolved.checkout.root,
        title: resolved.project.path.split("/").at(-1),
    });
    return { ...opened, root: resolved.checkout.root };
}
