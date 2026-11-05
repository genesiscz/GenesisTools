import { data, isError, text, withKit } from "@app/scripts/lib/kit";
import { loadRegistry, type Registry } from "@app/scripts/lib/registry";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { timeToUs } from "@genesiscz/utils/recording-editor/plan";
import { z } from "zod";

const { log } = logger.scoped("recorder-board-comments");

/**
 * Review comments from a vitrinka board: each annotation on a card that shows the recording (a shot, a movie, a
 * journey step with a screen) becomes a comment. The board is read through the vitrinka MCP's `scrape_board`, the
 * only door that answers a board's annotations with their cards: the `vitrinka` CLI lists open work items only (id,
 * board, intent, prompt, status; no card), checked 2026-11-05 on vitrinka 5.28.0. The read never writes to the board, and the
 * MCP kit never refreshes the borrowed token.
 *
 * A board keeps no time on an annotation (its record holds a region on the card, an intent and a prompt), so the
 * time is the one the reviewer wrote at the start of the prompt (`0:42`, `1:02:03`, `42s`, `@0:42`, `[0:42]`, a range
 * `0:42-0:45`), in OUTPUT time: what plays in the export the board shows. An annotation without one goes to 0:00 and
 * its comment says so.
 */
export const SCREEN_CARD_KINDS = ["shot", "media", "step"] as const;

const VITRINKA_SERVER = "vitrinka";
const TEXT_MAX = 2000;
const UNTIMED_NOTE = "[no time on the board; placed at 0:00]";

/** Which board, and which card of it; `workspace` and `origin` when the reference names them. */
export interface BoardRef {
    board: string;
    card?: number;
    workspace?: string;
    origin?: string;
}

/** The part of a `scrape_board` digest the import reads. */
const digestSchema = z.object({
    cards: z.array(
        z.object({
            id: z.number(),
            kind: z.string(),
            annotations: z
                .array(
                    z.object({
                        id: z.number(),
                        prompt: z.string().default(""),
                        by: z.string().optional(),
                        status: z.string().optional(),
                        cropUrl: z.string().optional(),
                    })
                )
                .default([]),
        })
    ),
});
export type BoardDigest = z.infer<typeof digestSchema>;

/** Reads a board's digest; the import's tests hand in a fixture. */
export type BoardDigestReader = (ref: BoardRef) => Promise<unknown>;

/** One comment the import adds, in OUTPUT seconds. */
export interface PlannedComment {
    annotation: number;
    card: number;
    atSec: number;
    toSec?: number;
    text: string;
    author?: string;
    link: string;
    resolved: boolean;
    /** No time on the board: placed at 0:00, and the text says so. */
    untimed: boolean;
}

export interface BoardImportPlan {
    comments: PlannedComment[];
    /** Annotations a comment of this recording already came from (a removed comment counts). */
    already: number;
    /** Annotations on cards that do not show the recording (a note, a callout), left out of a whole-board import. */
    notScreens: number;
}

/**
 * A board reference: an app URL (`https://app.vitrinka.ai/w/<workspace>/boards/<slug>?card=<id>`), `<workspace>/<slug>`
 * or a bare slug, which lands in the vitrinka account's default workspace. `card` (a `--card`) wins over the URL's.
 */
export function parseBoardRef(value: string, card?: number): BoardRef {
    const trimmed = value.trim();
    const pick = (fromUrl?: number) => card ?? fromUrl;

    if (/^https?:\/\//i.test(trimmed)) {
        const url = new URL(trimmed);
        const match = /^\/w\/([^/]+)\/boards\/([^/?#]+)/.exec(url.pathname);

        if (!match) {
            throw new Error(`${value} is not a vitrinka board link (…/w/<workspace>/boards/<slug>)`);
        }

        const fromUrl = url.searchParams.get("card");
        const picked = pick(fromUrl && /^\d+$/.test(fromUrl) ? Number(fromUrl) : undefined);
        return {
            board: decodeURIComponent(match[2]),
            workspace: decodeURIComponent(match[1]),
            origin: url.origin,
            ...(picked === undefined ? {} : { card: picked }),
        };
    }

    const parts = trimmed.split("/").filter(Boolean);

    if (parts.length === 0 || parts.length > 2) {
        throw new Error(`${value} is not a board: give its link, <workspace>/<slug> or its slug`);
    }

    const picked = pick();
    return {
        board: parts[parts.length - 1],
        ...(parts.length === 2 ? { workspace: parts[0] } : {}),
        ...(picked === undefined ? {} : { card: picked }),
    };
}

/**
 * The time the reviewer wrote at the start of a prompt, in seconds, and the text after it. Only an explicit clock
 * (`0:42`, `1:02:03.5`) or seconds with their `s` (`42s`) count: "3 buttons are off" is no time.
 */
export function promptTime(prompt: string): { atSec: number; toSec?: number; rest: string } | undefined {
    const time = String.raw`(?:\d+:)?\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?s`;
    const match = new RegExp(
        String.raw`^\s*[[(@]?\s*(${time})(?:\s*[-–—]\s*(${time}))?\s*[\])]?(?:\s*[:·,–—-]\s*|\s+|$)`
    ).exec(prompt);

    if (!match) {
        return undefined;
    }

    const atSec = timeToUs(match[1]) / 1e6;
    const toSec = match[2] ? timeToUs(match[2]) / 1e6 : undefined;
    return {
        atSec,
        ...(toSec !== undefined && toSec > atSec ? { toSec } : {}),
        rest: prompt.slice(match[0].length).trim(),
    };
}

/** The link a comment keeps: the board at the annotation's card, the annotation as the fragment. Also the import key. */
export function annotationLink({
    origin,
    workspace,
    board,
    card,
    annotation,
}: {
    origin: string;
    workspace: string;
    board: string;
    card: number;
    annotation: number;
}): string {
    return `${origin}/w/${encodeURIComponent(workspace)}/boards/${encodeURIComponent(board)}?card=${card}#annotation-${annotation}`;
}

/**
 * What an import adds: one comment per annotation of the card (a card ref) or of every card that shows the recording
 * (a board ref), minus the annotations a comment already came from (`known`: the links in the comments file,
 * removed comments included), so a second import adds nothing.
 */
export function planBoardImport({
    digest,
    ref,
    known,
}: {
    digest: unknown;
    ref: BoardRef;
    known: Set<string>;
}): BoardImportPlan {
    const parsed = digestSchema.parse(digest);
    const plan: BoardImportPlan = { comments: [], already: 0, notScreens: 0 };
    const cards = ref.card === undefined ? parsed.cards : parsed.cards.filter((card) => card.id === ref.card);

    if (ref.card !== undefined && cards.length === 0) {
        throw new Error(`board ${ref.board} has no card ${ref.card}`);
    }

    for (const card of cards) {
        const screen = (SCREEN_CARD_KINDS as readonly string[]).includes(card.kind);

        if (ref.card === undefined && !screen) {
            plan.notScreens += card.annotations.length;
            continue;
        }

        for (const annotation of card.annotations) {
            const place = placeOf(ref, annotation.cropUrl);
            const link = annotationLink({ ...place, board: ref.board, card: card.id, annotation: annotation.id });

            if (known.has(link)) {
                plan.already++;
                continue;
            }

            const time = promptTime(annotation.prompt);
            const body = time ? time.rest || annotation.prompt.trim() : annotation.prompt.trim();
            const text = clip(time ? body : `${UNTIMED_NOTE} ${body}`.trim());
            plan.comments.push({
                annotation: annotation.id,
                card: card.id,
                atSec: time?.atSec ?? 0,
                ...(time?.toSec === undefined ? {} : { toSec: time.toSec }),
                text,
                ...(annotation.by ? { author: annotation.by.slice(0, 80) } : {}),
                link,
                resolved: annotation.status === "resolved",
                untimed: !time,
            });
        }
    }

    log.debug(
        {
            board: ref.board,
            card: ref.card,
            add: plan.comments.length,
            already: plan.already,
            notScreens: plan.notScreens,
        },
        "board import planned"
    );
    return plan;
}

/** The board's digest from the vitrinka MCP (read only: `scrape_board` with a jq that keeps the annotated cards). */
export const readBoardDigest: BoardDigestReader = async (ref) => {
    const board = ref.workspace ? `${ref.workspace}/${ref.board}` : ref.board;
    log.debug({ board }, "reading the board's annotations through the vitrinka MCP");
    const raw = await withKit(
        (kit) =>
            kit.call(VITRINKA_SERVER, "scrape_board", {
                board,
                jq: "{cards: [.cards[]? | select((.annotations // []) | length > 0) | {id, kind, annotations}]}",
            }),
        { servers: [VITRINKA_SERVER], timeoutMs: 60_000, registry: await registryWithVitrinka() }
    );

    if (isError(raw)) {
        throw new Error(`vitrinka could not read board ${board}: ${text(raw).slice(0, 300)}`);
    }

    const parsed = data(raw);

    if (parsed === undefined) {
        throw new Error(`vitrinka answered no JSON for board ${board}: ${text(raw).slice(0, 200)}`);
    }

    return parsed;
};

/**
 * The MCP kit's server list, read from the provider configs only when its cache has no vitrinka entry: that read
 * took about two minutes on 2026-11-05 (57 servers), and it writes nothing, so the warning names the command that
 * caches it.
 */
async function registryWithVitrinka(): Promise<Registry> {
    const cached = await loadRegistry();

    if (cached.servers.some((server) => server.name === VITRINKA_SERVER)) {
        return cached;
    }

    log.warn(
        `the MCP server cache has no ${VITRINKA_SERVER} entry, so the provider configs are read (slow); ` +
            `${toolCommand("scripts servers", "--refresh")} caches it`
    );
    return loadRegistry({ refresh: true });
}

/** The origin and workspace of a link: the reference's, else the annotation's crop URL (`<origin>/w/<ws>/api/…`). */
function placeOf(ref: BoardRef, cropUrl: string | undefined): { origin: string; workspace: string } {
    const fromCrop = cropUrl ? /^(https?:\/\/[^/]+)\/w\/([^/]+)\//.exec(cropUrl) : null;
    const origin = ref.origin ?? fromCrop?.[1];
    const workspace = ref.workspace ?? (fromCrop ? decodeURIComponent(fromCrop[2]) : undefined);

    if (!origin || !workspace) {
        throw new Error(
            `the board ${ref.board} did not say its workspace; give the board's link or <workspace>/${ref.board}`
        );
    }

    return { origin, workspace };
}

function clip(value: string): string {
    return value.length <= TEXT_MAX ? value : `${value.slice(0, TEXT_MAX - 1)}…`;
}
