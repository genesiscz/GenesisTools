import axios from "axios";
import * as fs from "fs";
import * as path from "path";

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
	outputFile: string;
	limit?: number;
}

async function fetchReleaseNotes(options: ScriptOptions): Promise<void> {
	const { owner, repo, outputFile, limit } = options;

	try {
		console.log(`Fetching release notes for ${owner}/${repo}...`);

		// Determine how many releases to fetch
		const perPage = 100; // GitHub API maximum
		const maxPages = limit ? Math.ceil(limit / perPage) : Infinity;

		let allReleases: GitHubRelease[] = [];
		let page = 1;
		let hasMorePages = true;

		// Fetch releases page by page
		while (hasMorePages && page <= maxPages) {
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

		// Generate markdown content
		const markdownContent = generateMarkdown(allReleases, owner, repo);

		// Write to file
		const outputPath = path.resolve(outputFile);
		fs.writeFileSync(outputPath, markdownContent);

		console.log(`Release notes written to ${outputPath}`);
	} catch (error) {
		if (axios.isAxiosError(error)) {
			if (error.response?.status === 403) {
				console.error("Rate limit exceeded. Consider using a GitHub token by setting the GITHUB_TOKEN environment variable.");
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

function parseCommandLineArgs(): ScriptOptions {
	const args = process.argv.slice(2);

	if (args.length < 2) {
		console.log(`
Usage: ts-node github-release-notes.ts <owner>/<repo> <output-file> [options]

Arguments:
  owner/repo     GitHub repository in format "owner/repo"
  output-file    Path to the output markdown file

Options:
  --limit=<n>    Limit the number of releases to fetch

Example:
  ts-node github-release-notes.ts software-mansion/react-native-reanimated releases.md --limit=10
  
Note:
  To avoid GitHub API rate limits, you can set the GITHUB_TOKEN environment variable.
  export GITHUB_TOKEN=your_github_token
`);
		process.exit(1);
	}

	// Parse owner/repo
	const repoArg = args[0];
	const [owner, repo] = repoArg.split("/");

	if (!owner || !repo) {
		console.error('Invalid repository format. Use "owner/repo".');
		process.exit(1);
	}

	// Output file
	const outputFile = args[1];

	// Parse options
	const options: ScriptOptions = { owner, repo, outputFile };

	// Check for limit option
	const limitArg = args.find((arg) => arg.startsWith("--limit="));
	if (limitArg) {
		const limit = parseInt(limitArg.split("=")[1], 10);
		if (!isNaN(limit) && limit > 0) {
			options.limit = limit;
		} else {
			console.error("Invalid limit value. Must be a positive integer.");
			process.exit(1);
		}
	}

	return options;
}

// Main execution
const options = parseCommandLineArgs();
fetchReleaseNotes(options).catch(console.error);
