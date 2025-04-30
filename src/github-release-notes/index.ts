import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import minimist from "minimist";

interface GitHubRelease {
    tag_name: string;
    name: string;
    published_at: string;
    body: string;
    html_url: string;
}

interface ScriptOptions {
    owner: string;
    repo: string;
    outputFile: string | null;
    limit?: number;
    oldest?: boolean;
}

async function fetchReleaseNotes(options: ScriptOptions): Promise<void> {
    const { owner, repo, outputFile, limit, oldest } = options;

    try {
        console.log(`Fetching release notes for ${owner}/${repo}...`);

        const perPage = 100; // GitHub API maximum
        const maxPages = limit ? Math.ceil(limit / perPage) : 5;

        let allReleases: GitHubRelease[] = [];
        let page = 1;
        let hasMorePages = true;

        while (hasMorePages && page <= maxPages) {
            console.debug(`Fetching page ${page} of ${maxPages}...`);

            const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${perPage}&page=${page}`;

            const response = await axios.get(url, {
                headers: {
                    Accept: "application/vnd.github.v3+json",
                    // Use GitHub token from environment if available
                    ...(process.env.GITHUB_TOKEN && { Authorization: `token ${process.env.GITHUB_TOKEN}` }),
                },
            });

            const releases: GitHubRelease[] = response.data;

            if (releases.length === 0) {
                hasMorePages = false;
            } else {
                allReleases = [...allReleases, ...releases];
                page++;
            }

            // If we've reached the limit, stop fetching
            if (limit && allReleases.length >= limit) {
                allReleases = allReleases.slice(0, limit);
                hasMorePages = false;
            }
        }

        console.log(`Found ${allReleases.length} releases.`);

        // Sort releases
        if (oldest) {
            allReleases = allReleases.sort(
                (a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime()
            );
        } else {
            allReleases = allReleases.sort(
                (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
            );
        }

        // Generate markdown content
        const markdownContent = generateMarkdown(allReleases, owner, repo);

        if (!outputFile) {
            process.stdout.write(markdownContent);
        } else {
            const outputPath = path.resolve(outputFile);
            fs.writeFileSync(outputPath, markdownContent);
            console.log(`Release notes written to ${outputPath}`);
        }
    } catch (error) {
        if (axios.isAxiosError(error)) {
            if (error.response?.status === 403) {
                console.error(
                    "Rate limit exceeded. Consider using a GitHub token by setting the GITHUB_TOKEN environment variable."
                );
            } else if (error.response?.status === 404) {
                console.error(`Repository ${owner}/${repo} not found or no releases available.`);
            } else {
                console.error(`Error: ${error.message}`);
            }
        } else {
            console.error("An unknown error occurred:", error);
        }
        process.exit(1);
    }
}

function generateMarkdown(releases: GitHubRelease[], owner: string, repo: string): string {
    const headerContent =
        `# Release Notes: ${owner}/${repo}\n\n` +
        `This document contains the release notes for [${owner}/${repo}](https://github.com/${owner}/${repo}).\n\n` +
        `Generated on: ${new Date().toISOString().split("T")[0]}\n\n`;

    const releasesContent = releases
        .map((release) => {
            const date = new Date(release.published_at).toISOString().split("T")[0];

            return `## [${release.tag_name}](${release.html_url}) - ${date}\n\n` + `${release.body.trim()}\n`;
        })
        .join("\n\n---\n\n");

    return headerContent + releasesContent;
}

function parseRepoArg(repoArg: string): { owner: string; repo: string } | null {
    // Accepts owner/repo or full github.com URL
    if (!repoArg) return null;
    const githubUrlPattern = /github\.com[:/]+([^/]+)\/([^/]+)(?:\/|$)/i;
    const ownerRepoPattern = /^([^/]+)\/([^/]+)$/;

    let match = repoArg.match(githubUrlPattern);
    if (match) {
        return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
    }
    match = repoArg.match(ownerRepoPattern);
    if (match) {
        return { owner: match[1], repo: match[2] };
    }
    return null;
}

function printHelpAndExit(): void {
    console.log(`
Usage: bun src/github-release-notes/index.ts <owner>/<repo>|<github-url> <output-file> [options]

Arguments:
  owner/repo     GitHub repository in format "owner/repo" or full github.com URL
  output-file    Path to the output markdown file

Options:
  --limit=<n>    Limit the number of releases to fetch
  --oldest       Sort releases from oldest to newest (default is newest to oldest)
  -h, --help     Show this help message

Example:
  bun src/github-release-notes/index.ts software-mansion/react-native-reanimated releases.md --limit=10
  bun src/github-release-notes/index.ts https://github.com/software-mansion/react-native-reanimated releases.md
  bun src/github-release-notes/index.ts software-mansion/react-native-reanimated releases.md --oldest
  
Note:
  To avoid GitHub API rate limits, you can set the GITHUB_TOKEN environment variable.
  export GITHUB_TOKEN=your_github_token
`);
    process.exit(0);
}

function parseCommandLineArgs(): ScriptOptions {
    const argv = minimist(process.argv.slice(2), {
        alias: { h: "help" },
        boolean: ["help", "oldest"],
    });

    if (argv.help) {
        printHelpAndExit();
    }

    const [repoArg, outputFile] = argv._;

    if (!repoArg) {
        printHelpAndExit();
    }

    const repoInfo = parseRepoArg(repoArg);
    if (!repoInfo) {
        console.error('Invalid repository format. Use "owner/repo" or a full github.com URL.');
        process.exit(1);
    }

    const options: ScriptOptions = { owner: repoInfo.owner, repo: repoInfo.repo, outputFile };

    if (argv.limit) {
        const limit = parseInt(argv.limit, 10);
        if (!isNaN(limit) && limit > 0) {
            options.limit = limit;
        } else {
            console.error("Invalid limit value. Must be a positive integer.");
            process.exit(1);
        }
    }

    if (argv.oldest) {
        options.oldest = true;
    }

    return options;
}

const options = parseCommandLineArgs();
fetchReleaseNotes(options).catch(console.error);
