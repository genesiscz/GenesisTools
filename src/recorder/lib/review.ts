import {
    addComment,
    commentLinks,
    commentsPathFor,
    type ReviewComment,
    readComments,
    removeComment,
    updateComment,
} from "@genesiscz/utils/recording-editor/comments";
import { type TimeValue, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import { type EditProject, outputTimeOf, sourceTimeOf } from "@genesiscz/utils/recording-editor/project";
import { type BoardDigestReader, commentLink, parseBoardRef, planBoardImport, readBoardDigest } from "./board-comments";
import { openProject } from "./edit";

/**
 * Review comments of a recording for the CLI and the REPL (the window reads the same comments.jsonl). They are stored
 * at SOURCE times; these doors take and show OUTPUT times by default (what plays, as a reviewer of the export sees
 * it), with `source` for times in the recording itself.
 */
const seconds = (us: number) => Math.round(us / 1000) / 1000;

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
        ...(comment.author ? { author: comment.author } : {}),
        ...(comment.link ? { link: comment.link } : {}),
        resolved: comment.resolved === true,
        at: comment.at,
    };
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
 * A comment at `at` (to `to`). `link` is the page it came from; a vitrinka annotation link, or the board's link with
 * `annotation` (the annotation's number), is kept as the annotation's link (`commentLink`), so the comment opens it.
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
        source?: boolean;
    }
) {
    const link = commentLink({ link: options.link, annotation: options.annotation });
    const { project, path } = await opened(value);
    const toSource = (time: TimeValue) => (options.source ? timeToUs(time) : sourceTimeOf(project, timeToUs(time)));
    const comment = addComment(path, {
        atUs: toSource(options.at),
        ...(options.to === undefined ? {} : { toUs: toSource(options.to) }),
        text: options.text,
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
 * The annotations of a vitrinka board (or of one card of it) as review comments, at the OUTPUT times their prompts
 * start with (0:00 with a note when there is none). Idempotent: an annotation a comment already came from, removed
 * comments included, is never added again. `dryRun` reads the board and writes nothing.
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
        const comment = addComment(path, {
            atUs: sourceTimeOf(project, Math.round(planned.atSec * 1e6)),
            ...(planned.toSec === undefined ? {} : { toUs: sourceTimeOf(project, Math.round(planned.toSec * 1e6)) }),
            text: planned.text,
            author: planned.author,
            link: planned.link,
        });
        return shown(planned.resolved ? updateComment(path, comment.id, { resolved: true }) : comment, project);
    });
    return { ...summary, dryRun: false, wouldAdd: [], added };
}
