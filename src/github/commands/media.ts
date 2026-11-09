import {
    type MediaRepoApi,
    type MediaTarget,
    type MediaUploadResult,
    parseMediaArg,
    uploadMedia,
} from "@app/github/lib/media-upload";
import { formatBytes } from "@genesiscz/utils/format";
import { getGitHubToken, getOctokitForWrite } from "@genesiscz/utils/github/octokit";
import { detectRepoFromGit } from "@genesiscz/utils/github/url-parser";
import { logger, out } from "@genesiscz/utils/logger";
import chalk from "chalk";
import { Command } from "commander";

/** The REST calls of `media upload`, on the write client (`gh auth token` first). */
function octokitMediaApi(): MediaRepoApi {
    const octokit = getOctokitForWrite();

    return {
        getRepo: async (owner, repo) => {
            const { data } = await octokit.rest.repos.get({ owner, repo });
            return { id: data.id, canPush: data.permissions?.push === true };
        },
        // A PR is an issue to the issues API, so one pair of calls edits both bodies.
        getBody: async (ref) => {
            const { data } = await octokit.rest.issues.get({
                owner: ref.owner,
                repo: ref.repo,
                issue_number: ref.number,
            });
            return data.body ?? "";
        },
        setBody: async (ref) => {
            await octokit.rest.issues.update({
                owner: ref.owner,
                repo: ref.repo,
                issue_number: ref.number,
                body: ref.body,
            });
        },
    };
}

interface UploadFlags {
    repo?: string;
    pr?: string;
    issue?: string;
    append?: boolean;
    json?: boolean;
    dryRun?: boolean;
}

function parseNumber(flag: string, value: string): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`${flag} must be a positive number, got "${value}"`);
    }

    return number;
}

function targetFrom(flags: UploadFlags): MediaTarget | undefined {
    if (flags.pr && flags.issue) {
        throw new Error("give --pr or --issue, not both");
    }

    if (flags.pr) {
        return { kind: "pr", number: parseNumber("--pr", flags.pr) };
    }

    if (flags.issue) {
        return { kind: "issue", number: parseNumber("--issue", flags.issue) };
    }

    return undefined;
}

function printDryRun(result: MediaUploadResult): void {
    out.println(`Repository: ${result.repo} (id ${result.repoId})`);
    out.println(`Write access: ${result.canPush ? chalk.green("yes") : chalk.red("no")}`);
    for (const file of result.files) {
        out.println(`${file.file}  ${file.kind}  ${file.contentType}  ${formatBytes(file.bytes)}  ${file.verdict}`);
    }

    out.println(chalk.dim("Dry run: nothing was uploaded. An upload cannot be undone."));
}

export async function mediaUploadCommand(files: string[], flags: UploadFlags): Promise<void> {
    const repo = flags.repo ?? (await detectRepoFromGit());
    if (!repo) {
        throw new Error("--repo owner/repo is required here: this folder has no GitHub origin remote");
    }

    const target = targetFrom(flags);

    const result = await uploadMedia(
        {
            repo,
            files: files.map(parseMediaArg),
            dryRun: flags.dryRun,
            target,
            append: flags.append,
        },
        {
            api: octokitMediaApi(),
            token: () => {
                const token = getGitHubToken("prefer-gh-cli");
                if (!token) {
                    throw new Error("No GitHub token. Run `gh auth login` or set GITHUB_TOKEN.");
                }

                return token;
            },
        }
    );

    if (flags.json) {
        out.result(
            result.files.map((file) => ({
                file: file.file,
                url: file.url,
                kind: file.kind,
                bytes: file.bytes,
                contentType: file.contentType,
                markdown: file.markdown,
                ...(file.verdict ? { verdict: file.verdict } : {}),
            }))
        );
        return;
    }

    if (result.dryRun) {
        printDryRun(result);
        return;
    }

    for (const file of result.files) {
        out.println(file.markdown ?? "");
    }

    if (target && !result.appended) {
        out.log.info(
            `Uploaded for ${target.kind === "pr" ? "PR" : "issue"} #${target.number}. Its body is unchanged; add --append to write the lines into it.`
        );
    }

    if (result.appended && target) {
        out.log.info(
            `Appended ${result.files.length} line(s) to the body of ${target.kind === "pr" ? "PR" : "issue"} #${target.number}.`
        );
    }
}

/** `tools github media`. */
export function createMediaCommand(): Command {
    const media = new Command("media").description("Images and videos for PRs and issues");

    media.addCommand(
        new Command("upload")
            .description(
                "Upload local images and videos to GitHub (user-attachments) and print the markdown. An upload cannot be undone."
            )
            .argument("<files...>", "Files to upload; `path#alt text` sets an image's alt text")
            .option("-r, --repo <owner/repo>", "Repository the files belong to (default: the origin of this folder)")
            .option("--pr <number>", "Label the output with this PR")
            .option("--issue <number>", "Label the output with this issue")
            .option("--append", "With --pr or --issue: write the markdown lines into that body")
            .option("--dry-run", "Print the repo id, write access and a verdict per file; upload nothing")
            .option("--json", "Print [{ file, url, kind, bytes, contentType, markdown }] as JSON")
            .action(async (files: string[], flags: UploadFlags) => {
                try {
                    await mediaUploadCommand(files, flags);
                } catch (error) {
                    logger.error({ error }, "github media upload failed");
                    out.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );

    return media;
}
