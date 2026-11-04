import {
    addComment,
    commentsPathFor,
    type ReviewComment,
    readComments,
    removeComment,
    updateComment,
} from "@genesiscz/utils/recording-editor/comments";
import { type TimeValue, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import { type EditProject, outputTimeOf, sourceTimeOf } from "@genesiscz/utils/recording-editor/project";
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

export async function commentOn(
    value: string,
    options: { at: TimeValue; to?: TimeValue; text: string; author?: string; link?: string; source?: boolean }
) {
    const { project, path } = await opened(value);
    const toSource = (time: TimeValue) => (options.source ? timeToUs(time) : sourceTimeOf(project, timeToUs(time)));
    const comment = addComment(path, {
        atUs: toSource(options.at),
        ...(options.to === undefined ? {} : { toUs: toSource(options.to) }),
        text: options.text,
        author: options.author,
        link: options.link,
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
