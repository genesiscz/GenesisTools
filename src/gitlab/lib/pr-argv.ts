/**
 * `gitlab pr <mr> <verb…> [args]` is the public form: the merge request first, then what to do with
 * it. Commander cannot parse a value in front of a subcommand (the parent's argument swallows the
 * next word), so the CLI rewrites the public form into the internal one before Commander runs:
 * every leaf under `pr` takes the MR as its first argument.
 *
 *   pr 7412                         → pr show 7412
 *   pr !7412 comments               → pr comments list 7412
 *   pr 7412 comments reply T03 …    → pr comments reply 7412 T03 …
 *   pr 7412,7413 labels --add x     → pr labels 7412,7413 --add x
 *   pr https://host/g/p/-/merge_requests/7412 review
 *                                   → pr review 7412 --host https://host --project g/p
 *
 * A first word that is not an MR (`stale`, `touching`, `--help`) leaves the argv unchanged.
 */

/** A command group as the rewrite sees it: its subcommand names and the leaf a bare group runs. */
export interface CommandNode {
    children: Map<string, CommandNode>;
    defaultChild?: string;
}

const MR_NUMBER = /^!?\d+$/;
const MR_URL = /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/;

/** `7412`, `!7412`, `7412,7413`, or an MR URL. */
export function isMrRef(token: string): boolean {
    return token.split(",").every((part) => MR_NUMBER.test(part)) || MR_URL.test(token);
}

interface ParsedMrRef {
    iids: string;
    host?: string;
    project?: string;
}

function parseMrRef(token: string): ParsedMrRef {
    const url = MR_URL.exec(token);

    if (url) {
        return { iids: url[3], host: url[1], project: url[2] };
    }

    return { iids: token.replace(/!/g, "") };
}

function hasOption(args: string[], name: string): boolean {
    return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/** The index of the first word that is not an option, or -1. */
function firstWord(args: string[]): number {
    return args.findIndex((arg) => !arg.startsWith("-"));
}

/** A group run without a verb runs its default leaf: `activity user --days 7` → `activity user events --days 7`. */
function withDefaultLeaves(args: string[], root: CommandNode): string[] {
    const at = firstWord(args);

    if (at === -1) {
        return args;
    }

    let node = root;
    let index = at;

    while (index < args.length) {
        const child = node.children.get(args[index]);

        if (!child) {
            break;
        }

        node = child;
        index++;
    }

    const inserted: string[] = [];

    while (node.defaultChild && !(args[index] && node.children.has(args[index]))) {
        const child = node.children.get(node.defaultChild);

        if (!child || args.slice(index).some((arg) => arg === "--help" || arg === "-h")) {
            break;
        }

        inserted.push(node.defaultChild);
        node = child;
    }

    return [...args.slice(0, index), ...inserted, ...args.slice(index)];
}

/** The whole rewrite: the MR moves behind the path under `pr`, and every bare group gets its default leaf. */
export function rewriteArgv(args: string[], root: CommandNode): string[] {
    const pr = root.children.get("pr");

    // Under `pr` only an MR selects the default leaf: a bare `gitlab pr` prints its help.
    if (args[firstWord(args)] === "pr") {
        return pr ? rewritePrArgv(args, pr) : args;
    }

    return withDefaultLeaves(args, root);
}

export function rewritePrArgv(args: string[], pr: CommandNode): string[] {
    const at = firstWord(args);

    if (at === -1 || args[at] !== "pr") {
        return args;
    }

    const refAt = at + 1;
    const ref = args[refAt];

    if (ref === undefined || !isMrRef(ref)) {
        return args;
    }

    const { iids, host, project } = parseMrRef(ref);
    const rest = args.slice(refAt + 1);
    const path: string[] = [];
    let node = pr;
    let index = 0;

    while (index < rest.length) {
        const child = node.children.get(rest[index]);

        if (!child) {
            break;
        }

        path.push(rest[index]);
        node = child;
        index++;
    }

    const tail = rest.slice(index);

    // `pr 42 review --help` asks what the group can do, so it gets the group's help, not its default leaf's.
    if (node.defaultChild && (hasOption(tail, "--help") || hasOption(tail, "-h"))) {
        return [...args.slice(0, refAt), ...path, ...tail];
    }

    while (node.defaultChild) {
        const child = node.children.get(node.defaultChild);

        if (!child) {
            break;
        }

        path.push(node.defaultChild);
        node = child;
    }

    const target: string[] = [];

    if (host && !hasOption(tail, "--host")) {
        target.push("--host", host);
    }

    if (project && !hasOption(tail, "--project")) {
        target.push("--project", project);
    }

    return [...args.slice(0, refAt), ...path, iids, ...tail, ...target];
}
