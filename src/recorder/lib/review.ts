import {
    addComment,
    commentLinks,
    commentsPathFor,
    type ReviewComment,
    readComments,
    removeComment,
    updateComment,
} from "@genesiscz/utils/recording-editor/comments";
import { cardsLeadUs } from "@genesiscz/utils/recording-editor/overlays";
import { type TimeValue, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import {
    type EditClock,
    type EditProject,
    exportToOutputClampedUs,
    outputTimeOf,
    sourceTimeOf,
} from "@genesiscz/utils/recording-editor/project";
import { type BoardDigestReader, commentLink, parseBoardRef, planBoardImport, readBoardDigest } from "./board-comments";
import { openProject } from "./edit";

/**
 * Review comments of a recording for the CLI and the REPL (the window reads the same comments.jsonl). They are stored
 * at SOURCE times. A typed comment takes OUTPUT times by default (the editor's timeline: the movie without its cards),
 * `clock: "export"` for times of the exported file (a player's clock, the intro card first) and `clock: "source"` for
 * times in the recording itself. A board's annotations are times of the exported file the board shows. An answer gives
 * `plays` in OUTPUT seconds and `exportPlays` in the exported file's seconds.
 */
const seconds = (us: number) => Math.round(us / 1000) / 1000;

/** What a comment's text says when a time of the exported file was on a card and moved onto the movie. */
const CARD_NOTES = {
    intro: "[on the intro card; placed at the movie's start]",
    end: "[on the end card; placed at the movie's end]",
} as const;

function shown(comment: ReviewComment, project: EditProject) {
    const plays = outputTimeOf(project, comment.atUs);
    return {
        id: comment.id,
        text: comment.text,
        /** Source seconds. */
        from: seconds(comment.atUs),
        ...(comment.toUs === undefined ? {} : { to: seconds(comment.toUs) }),
        /** Where it plays in the edit now; null when that moment is cut. */
        plays: plays === undefined ? null : seconds(plays),
        /** Where it plays in the exported file (after the intro card); null when that moment is cut. */
        exportPlays: plays === undefined ? null : seconds(plays + cardsLeadUs(project)),
        ...(comment.author ? { author: comment.author } : {}),
        ...(comment.link ? { link: comment.link } : {}),
        resolved: comment.resolved === true,
        at: comment.at,
    };
}

/**
 * A comment's times on `clock` as SOURCE microseconds. A time of the exported file on a card moves onto the movie
 * (exportToOutputClampedUs), and `note` names the card, the start's first.
 */
function commentTimes(
    project: EditProject,
    clock: EditClock,
    times: { atUs: number; toUs?: number }
): { atUs: number; toUs?: number; note?: string } {
    if (clock === "source") {
        return times;
    }

    if (clock === "output") {
        return {
            atUs: sourceTimeOf(project, times.atUs),
            ...(times.toUs === undefined ? {} : { toUs: sourceTimeOf(project, times.toUs) }),
        };
    }

    const at = exportToOutputClampedUs(project, times.atUs);
    const to = times.toUs === undefined ? undefined : exportToOutputClampedUs(project, times.toUs);
    const card = at.inCard ?? to?.inCard;
    return {
        atUs: sourceTimeOf(project, at.outUs),
        ...(to === undefined ? {} : { toUs: sourceTimeOf(project, to.outUs) }),
        ...(card ? { note: CARD_NOTES[card] } : {}),
    };
}

/** The clock a typed comment's times are on; `source: true` is the older name of `clock: "source"`. */
function commentClock(options: { clock?: EditClock; source?: boolean }): EditClock {
    if (options.source && options.clock !== undefined && options.clock !== "source") {
        throw new Error(`source: true and clock "${options.clock}" name two clocks; give one`);
    }

    return options.clock ?? (options.source ? "source" : "output");
}

async function opened(value: string) {
    const { project } = await openProject(value);
    return { project, path: commentsPathFor(project.source.video) };
}

export async function commentsOf(value: string) {
    const { project, path } = await opened(value);
    return { path, comments: readComments(path).map((comment) => shown(comment, project)) };
}

/**
 * A comment at `at` (to `to`), on `clock` (output by default; see the module doc). `link` is the page it came from; a
 * vitrinka annotation link, or the board's link with `annotation` (the annotation's number), is kept as the
 * annotation's link (`commentLink`), so the comment opens it.
 */
export async function commentOn(
    value: string,
    options: {
        at: TimeValue;
        to?: TimeValue;
        text: string;
        author?: string;
        link?: string;
        annotation?: number;
        clock?: EditClock;
        /** The older name of `clock: "source"`. */
        source?: boolean;
    }
) {
    const clock = commentClock(options);
    const link = commentLink({ link: options.link, annotation: options.annotation });
    const { project, path } = await opened(value);
    const times = commentTimes(project, clock, {
        atUs: timeToUs(options.at),
        ...(options.to === undefined ? {} : { toUs: timeToUs(options.to) }),
    });
    const comment = addComment(path, {
        atUs: times.atUs,
        ...(times.toUs === undefined ? {} : { toUs: times.toUs }),
        text: times.note ? `${times.note} ${options.text}` : options.text,
        author: options.author,
        link,
    });
    return { path, comment: shown(comment, project) };
}

export async function resolveComment(value: string, id: string, resolved = true) {
    const { project, path } = await opened(value);
    return { path, comment: shown(updateComment(path, id, { resolved }), project) };
}

export async function uncomment(value: string, id: string) {
    const { path } = await opened(value);
    removeComment(path, id);
    return { path, removed: id };
}

/**
 * The annotations of a vitrinka board (or of one card of it) as review comments, at the times their prompts start with
 * (0:00 with a note when there is none). The board shows the exported movie, so those are times of the exported file:
 * the intro card's length comes off, and a time on a card moves onto the movie with a note. Idempotent: an annotation
 * a comment already came from, removed comments included, is never added again. `dryRun` reads the board and writes
 * nothing; its `wouldAdd` keeps the times as the board has them.
 */
export async function importBoardComments(
    value: string,
    options: { board: string; card?: number; dryRun?: boolean; read?: BoardDigestReader }
) {
    const { project, path } = await opened(value);
    const ref = parseBoardRef(options.board, options.card);
    const digest = await (options.read ?? readBoardDigest)(ref);
    const plan = planBoardImport({ digest, ref, known: commentLinks(path) });
    const summary = {
        path,
        board: ref.board,
        ...(ref.card === undefined ? {} : { card: ref.card }),
        untimed: plan.comments.filter((comment) => comment.untimed).length,
        alreadyImported: plan.already,
        notOnScreens: plan.notScreens,
    };

    if (options.dryRun) {
        return { ...summary, dryRun: true, wouldAdd: plan.comments, added: [] };
    }

    const added = plan.comments.map((planned) => {
        const times = commentTimes(project, "export", {
            atUs: Math.round(planned.atSec * 1e6),
            ...(planned.toSec === undefined ? {} : { toUs: Math.round(planned.toSec * 1e6) }),
        });
        // An untimed annotation already says where it was placed.
        const note = planned.untimed ? undefined : times.note;
        const comment = addComment(path, {
            atUs: times.atUs,
            ...(times.toUs === undefined ? {} : { toUs: times.toUs }),
            text: note ? `${note} ${planned.text}` : planned.text,
            author: planned.author,
            link: planned.link,
        });
        return shown(planned.resolved ? updateComment(path, comment.id, { resolved: true }) : comment, project);
    });
    return { ...summary, dryRun: false, wouldAdd: [], added };
}
