import { homedir } from "node:os";
import {
    emptyCounts,
    loadPersonalMarkers,
    type PersonalMarker,
    type RedactionCounts,
    redactIssueText,
} from "@app/github/lib/issue-redact";
import { getOctokitForWrite } from "@genesiscz/utils/github/octokit";
import { logger, out } from "@genesiscz/utils/logger";
import chalk from "chalk";
import { Command } from "commander";

export interface NewIssue {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
}

/** The one call `post` makes (`POST /repos/{owner}/{repo}/issues`). A test hands in a recorder. */
export interface IssueWriteClient {
    createIssue(issue: NewIssue): Promise<{ number: number | null; url: string | null }>;
}

/** The write client (`gh auth token` first), as `IssueWriteClient`. */
function octokitIssueClient(): IssueWriteClient {
    const octokit = getOctokitForWrite();
    return {
        createIssue: async (issue) => {
            const { owner, repo, title, body, labels } = issue;
            const response = await octokit.rest.issues.create({ owner, repo, title, body, labels });
            return { number: response.data.number, url: response.data.html_url };
        },
    };
}

export interface PostIssueInput {
    /** `owner/repo`. */
    repo: string;
    title: string;
    body: string;
    labels?: string[];
    redact?: boolean;
    dryRun?: boolean;
}

export interface PostIssueResult {
    posted: boolean;
    number: number | null;
    url: string | null;
    repo: string;
    title: string;
    body: string;
    labels: string[];
    replaced: RedactionCounts;
    skippedMarkers: string[];
}

export interface PostIssueDeps {
    client?: () => IssueWriteClient;
    markers?: () => PersonalMarker[];
    homeDir?: string;
}

/**
 * Opens an issue: the title and body as given, or with `redact` first run through the personal-data list and the
 * secrets redactor (what was replaced is counted, never printed). With `redact`, a marker JavaScript cannot compile
 * stops the post before GitHub is called. `dryRun` returns what would be posted and never reaches GitHub.
 */
export async function postIssue(input: PostIssueInput, deps: PostIssueDeps = {}): Promise<PostIssueResult> {
    const [owner, name, ...rest] = input.repo.split("/");
    if (!owner || !name || rest.length > 0) {
        throw new Error(`--repo must be owner/repo, got "${input.repo}"`);
    }

    if (input.title.trim() === "") {
        throw new Error("the issue needs a title");
    }

    const replaced = emptyCounts();
    const skipped = new Set<string>();
    let title = input.title.trim();
    let body = input.body;

    if (input.redact) {
        const markers = (deps.markers ?? loadPersonalMarkers)();
        const options = { markers, homeDir: deps.homeDir ?? homedir(), counts: replaced, skipped };
        title = redactIssueText(title, options);
        body = redactIssueText(body, options);

        // A marker JavaScript cannot compile was not applied, so its personal data is still in the text: refuse to
        // post. A dry run still returns `skippedMarkers`, so the list can be fixed first.
        if (skipped.size > 0 && !input.dryRun) {
            throw new Error(
                `--redact cannot apply these personal-data markers, so nothing was posted: ${[...skipped].join(", ")}`
            );
        }
    }

    const labels = input.labels ?? [];
    const result: PostIssueResult = {
        posted: false,
        number: null,
        url: null,
        repo: input.repo,
        title,
        body,
        labels,
        replaced,
        skippedMarkers: [...skipped],
    };

    if (input.dryRun) {
        logger.debug({ repo: input.repo, replaced }, "github issue post: dry run, nothing sent");
        return result;
    }

    const client = (deps.client ?? octokitIssueClient)();
    const issue: NewIssue = { owner, repo: name, title, body };
    if (labels.length > 0) {
        issue.labels = labels;
    }

    logger.debug({ repo: input.repo, labels, replaced }, "github issue post: creating the issue");
    const created = await client.createIssue(issue);
    logger.debug({ repo: input.repo, number: created.number, url: created.url }, "github issue post: created");
    return { ...result, posted: true, ...created };
}

interface PostFlags {
    repo: string;
    title: string;
    bodyFile?: string;
    body?: string;
    redact?: boolean;
    label: string[];
    json?: boolean;
    dryRun?: boolean;
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/** `tools github issue post` (also `tools github issues post`). */
export function createIssuePostCommand(): Command {
    return new Command("post")
        .description("Open a new issue: the title and a body file, optionally redacted first")
        .requiredOption("-r, --repo <owner/repo>", "Repository to open the issue in")
        .requiredOption("-t, --title <text>", "Issue title")
        .option("--body-file <file>", "Markdown file with the issue body ('-' reads stdin)")
        .option("--body <text>", "Issue body as text (instead of --body-file)")
        .option("--redact", "Replace personal data and secrets in the title and body before posting, and say how many")
        .option("-l, --label <name>", "A label (repeat for more)", collect, [] as string[])
        .option("--dry-run", "Print what would be posted; nothing is sent to GitHub")
        .option("--json", "Print { posted, number, url, title, body, replaced } as JSON")
        .action(async (flags: PostFlags) => {
            try {
                const body = await readBody(flags);
                const result = await postIssue({
                    repo: flags.repo,
                    title: flags.title,
                    body,
                    labels: flags.label,
                    redact: flags.redact,
                    dryRun: flags.dryRun,
                });

                if (flags.json) {
                    out.result(result);
                    return;
                }

                printResult(result, flags);
            } catch (error) {
                logger.error({ error }, "github issue post failed");
                out.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                process.exit(1);
            }
        });
}

async function readBody(flags: PostFlags): Promise<string> {
    if (flags.bodyFile === "-") {
        return await Bun.stdin.text();
    }

    if (flags.bodyFile) {
        return await Bun.file(flags.bodyFile).text();
    }

    return flags.body ?? "";
}

function printResult(result: PostIssueResult, flags: PostFlags): void {
    if (flags.redact) {
        const parts = Object.entries(result.replaced)
            .filter(([, n]) => n > 0)
            .map(([kind, n]) => `${n} ${kind}`);
        out.log.info(parts.length > 0 ? `Redacted: ${parts.join(", ")}` : "Redacted: nothing matched");
        if (result.skippedMarkers.length > 0) {
            out.log.warn(`Skipped markers JavaScript cannot compile: ${result.skippedMarkers.join(", ")}`);
        }
    }

    if (!result.posted) {
        out.println(chalk.dim(`Dry run: nothing was posted to ${result.repo}.`));
        out.println(`Title: ${result.title}`);
        out.println(result.body);
        return;
    }

    out.println(result.url ?? `Posted issue #${result.number ?? "?"}`);
}
