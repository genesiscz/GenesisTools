// Thin HTTP wrappers over the AI expression layer routes (compose/arrange/update-cards/scrape/
// sections/questions) — mirrors read-tools.ts/work-tools.ts's pattern. Handlers return the JSON
// response raw (compact) so agents consume the same shape the HTTP API returns.
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { SafeJSON } from "@app/utils/json";
import { BoardsHttpError, boardsBaseUrl, boardsFetch, compact } from "./http";
import type { ArrangeMode } from "./schemas";

type OptionInput = string | { label: string; hint?: string; recommended?: boolean };

/** The authoritative clickable page for a board — relay THIS to the user, never a guessed host/port. */
async function boardPageUrl(slug: string): Promise<string> {
    return `${await boardsBaseUrl()}/boards/${slug}`;
}

export async function handleCreateBoard(args: { slug: string; title?: string; project?: string }): Promise<string> {
    const res = await boardsFetch<Record<string, unknown>>(paths.boards(), {
        method: "POST",
        body: SafeJSON.stringify({
            slug: args.slug,
            ...(args.title ? { title: args.title } : {}),
            ...(args.project ? { project: args.project } : {}),
        }),
    });
    return compact({ ...res, url: await boardPageUrl(args.slug) });
}

export async function handleAskBoard(args: {
    board: string;
    prompt: string;
    options: OptionInput[];
    multiSelect?: boolean;
    cardId?: number;
}): Promise<string> {
    const res = await boardsFetch<Record<string, unknown>>(paths.boardQuestions(args.board), {
        method: "POST",
        body: SafeJSON.stringify({
            prompt: args.prompt,
            options: args.options,
            ...(args.multiSelect ? { multiSelect: true } : {}),
            ...(args.cardId !== undefined ? { cardId: args.cardId } : {}),
        }),
    });
    return compact(res);
}

export async function handleComposeBoard(args: {
    board: string;
    layout?: "column" | "row" | "grid";
    anchorCardId?: number;
    section?: string;
    journey?: string;
    pass?: number | "next";
    cards?: unknown[];
    edges?: unknown[];
    questions?: unknown[];
}): Promise<string> {
    try {
        const res = await boardsFetch<Record<string, unknown>>(paths.boardCompose(args.board), {
            method: "POST",
            body: SafeJSON.stringify({
                ...(args.layout ? { layout: args.layout } : {}),
                ...(args.anchorCardId !== undefined ? { anchorCardId: args.anchorCardId } : {}),
                ...(args.section ? { section: args.section } : {}),
                ...(args.journey ? { journey: args.journey } : {}),
                ...(args.pass !== undefined ? { pass: args.pass } : {}),
                cards: args.cards ?? [],
                edges: args.edges ?? [],
                questions: args.questions ?? [],
            }),
        });
        return compact({ ...res, url: await boardPageUrl(args.board) });
    } catch (err) {
        if (err instanceof BoardsHttpError && err.status === 404) {
            throw new Error(
                `${err.message} — compose never auto-creates a board; ` +
                    `create "${args.board}" first with boards_create_board, then compose onto it.`
            );
        }
        throw err;
    }
}

export async function handleArrange(args: {
    board: string;
    mode: ArrangeMode;
    save?: boolean;
    sections?: string[];
    scope?: string;
    ids?: number[];
    gap?: string | number;
    padding?: string | number;
    cols?: number;
    sizing?: "natural" | "uniform";
}): Promise<string> {
    const res = await boardsFetch<Record<string, unknown>>(paths.boardArrange(args.board), {
        method: "POST",
        body: SafeJSON.stringify({
            mode: args.mode,
            ...(args.scope ? { scope: args.scope } : {}),
            ...(args.ids && args.ids.length > 0 ? { ids: args.ids } : {}),
            ...(args.gap !== undefined ? { gap: args.gap } : {}),
            ...(args.padding !== undefined ? { padding: args.padding } : {}),
            ...(args.cols !== undefined ? { cols: args.cols } : {}),
            ...(args.sizing ? { sizing: args.sizing } : {}),
            ...(args.save ? { save: true } : {}),
            ...(args.sections && args.sections.length > 0 ? { sections: args.sections } : {}),
        }),
    });
    return compact(res);
}

export async function handleUpdateCards(args: {
    board: string;
    patch?: Array<{ id: number; x?: number; y?: number; w?: number; h?: number; payload?: Record<string, unknown> }>;
    remove?: number[];
    restore?: number[];
}): Promise<string> {
    const res = await boardsFetch<Record<string, unknown>>(paths.boardUpdateCards(args.board), {
        method: "POST",
        body: SafeJSON.stringify({
            patch: args.patch ?? [],
            remove: args.remove ?? [],
            ...(args.restore && args.restore.length > 0 ? { restore: args.restore } : {}),
        }),
    });
    return compact(res);
}

export async function handleScrapeBoard(args: { board: string; section?: string; diff?: string[] }): Promise<string> {
    const path = paths.boardScrape(args.board, {
        section: args.section,
        diff: args.diff?.join(","),
    });
    const res = await boardsFetch<Record<string, unknown>>(path);
    return compact(res);
}

export async function handleListSections(args: { board: string }): Promise<string> {
    const res = await boardsFetch<Record<string, unknown>>(paths.boardSections(args.board));
    return compact(res);
}

export async function handleListProjects(): Promise<string> {
    const res = await boardsFetch<Record<string, unknown>>(paths.boardsProjects());
    return compact(res);
}

export async function handleUpdateSet(args: {
    project: string;
    branch: string;
    selector: string;
    name?: string;
    title?: string;
}): Promise<string> {
    const patch: Record<string, string> = {};
    if (args.name !== undefined) {
        patch.name = args.name;
    }
    if (args.title !== undefined) {
        patch.title = args.title;
    }
    const res = await boardsFetch<Record<string, unknown>>(
        paths.boardsSet({ project: args.project, branch: args.branch, selector: args.selector }),
        {
            method: "PATCH",
            body: SafeJSON.stringify(patch),
        }
    );
    return compact(res);
}

export async function handleGetTemplates(): Promise<string> {
    return boardsFetch<string>(paths.boardsTemplates(), { rawText: true });
}
