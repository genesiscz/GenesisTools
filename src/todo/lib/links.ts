import type { TodoLink } from "./types";

const SHORTHAND_RE = /^(pr|issue|ado):(.+)$/i;
const GITHUB_PR_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const GITHUB_ISSUE_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/;
const URL_RE = /^https?:\/\//;

export function parseLink(input: string): TodoLink {
    if (!input) {
        throw new Error("Link cannot be empty");
    }

    const shorthand = input.match(SHORTHAND_RE);

    if (shorthand) {
        return {
            type: shorthand[1].toLowerCase() as TodoLink["type"],
            ref: shorthand[2],
        };
    }

    const prMatch = input.match(GITHUB_PR_RE);

    if (prMatch) {
        return { type: "pr", ref: prMatch[2], repo: prMatch[1] };
    }

    const issueMatch = input.match(GITHUB_ISSUE_RE);

    if (issueMatch) {
        return { type: "issue", ref: issueMatch[2], repo: issueMatch[1] };
    }

    if (URL_RE.test(input)) {
        return { type: "url", ref: input };
    }

    throw new Error(`Unrecognized link format: ${input}`);
}

export function parseLinks(inputs: string[]): TodoLink[] {
    return inputs.map(parseLink);
}
