import minimist from "minimist";
import Enquirer from "enquirer";
import chalk from "chalk";
import { Gitlab } from "@gitbeaker/rest";
import logger from "../logger";

// Define your options interface
interface Options {
    project?: string;
    mr?: string;
    token?: string;
    help?: boolean;
}

interface Args extends Options {
    _: string[]; // Positional arguments
}

// Create Enquirer instance for interactive prompts
const prompter = new Enquirer();

// Show help message
function showHelp() {
    logger.info(`
Usage: tools gitlab [options]

Get GitLab merge request information from https://gitlab.apps.corp/

Options:
  -p, --project    Project ID or path (e.g., 'group/project' or numeric ID)
  -m, --mr         Merge request number (default: 6321)
  -t, --token      GitLab personal access token
  -h, --help       Show this help message

Examples:
  tools gitlab -p col/col-fe -m 6321
  tools gitlab --project mygroup/myproject --mr 456
  tools gitlab  # Uses default project: col/col-fe

To create a personal access token:

Quick setup: https://gitlab.apps.corp/-/user_settings/personal_access_tokens?name=GenesisTools%20GitLab%20API&scopes=read_api,read_repository,ai_features

Or manually:
1. Go to https://gitlab.apps.corp/-/user_settings/personal_access_tokens
2. Click "Create a personal access token"
3. Give it a name (e.g., "GenesisTools GitLab API")
4. Select scopes: "read_api", "read_repository", and "ai_features" (for AI features)
5. Click "Create personal access token"
6. Copy the token (you won't see it again!)

Required scopes:
• read_api: Grants read access to the API, including all groups and projects
• read_repository: Grants read-only access to repositories on private projects
• ai_features: Grants access to GitLab Duo related API endpoints
`);
}

async function main() {
    // Parse command line arguments
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            p: "project",
            m: "mr",
            t: "token",
            h: "help",
        },
        boolean: ["help"],
        string: ["project", "mr", "token"],
        default: {
            mr: "6321",
        },
    });

    // Show help if requested
    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    // Get project ID - defaults to col/col-fe
    let projectId = argv.project || argv._[0];

    // Get merge request number
    let mergeRequestIid = argv.mr || argv._[1];

    // Get access token
    let token = argv.token;
    if (!token) {
        logger.info(`
${chalk.bold("GitLab Access Token Required")}

To create a personal access token:
1. Go to ${chalk.cyan(
            "https://gitlab.apps.corp/-/user_settings/personal_access_tokens?name=tools%20GitLab%20API&scopes=read_api,read_repository,ai_features"
        )}
2. Click ${chalk.green('"Create a personal access token"')}
3. Give it a name (e.g., ${chalk.yellow('"API Access"')})
4. Select scopes: at minimum ${chalk.yellow('"read_api"')} and ${chalk.yellow('"read_repository"')}
5. Click ${chalk.green('"Create personal access token"')}
6. Copy the token ${chalk.red("(you won't see it again!)")}

${chalk.bold("Enter your GitLab personal access token:")}
`);

        try {
            const response = (await prompter.prompt({
                type: "password",
                name: "token",
                message: "GitLab Personal Access Token:",
            })) as { token: string };

            token = response.token;
        } catch (error: any) {
            if (error.message === "canceled") {
                logger.info("\nOperation cancelled by user.");
                process.exit(0);
            }
            throw error;
        }
    }

    if (!token) {
        logger.error("No access token provided. Exiting.");
        process.exit(1);
    }

    try {
        // Initialize GitLab API client
        const api = new Gitlab({
            host: "https://gitlab.apps.corp",
            token: token,
            rejectUnauthorized: false, // Ignore SSL certificate issues
        });

        logger.info(`Fetching merge request ${mergeRequestIid} from project ${projectId}...`);

        // Get the merge request
        const mergeRequest = await api.MergeRequests.show(projectId, parseInt(mergeRequestIid));

        // Display the merge request information
        console.log("\n" + chalk.bold("Merge Request Details:"));
        console.log(chalk.cyan("=".repeat(50)));
        console.log(`${chalk.bold("Title:")} ${mergeRequest.title}`);
        console.log(`${chalk.bold("ID:")} ${mergeRequest.iid} (${mergeRequest.id})`);
        console.log(`${chalk.bold("State:")} ${mergeRequest.state}`);
        console.log(`${chalk.bold("Author:")} ${mergeRequest.author?.name} (${mergeRequest.author?.username})`);
        console.log(`${chalk.bold("Assignee:")} ${mergeRequest.assignee?.name || "None"}`);
        console.log(`${chalk.bold("Source Branch:")} ${mergeRequest.source_branch}`);
        console.log(`${chalk.bold("Target Branch:")} ${mergeRequest.target_branch}`);
        console.log(`${chalk.bold("Created:")} ${new Date(mergeRequest.created_at).toLocaleString()}`);
        console.log(`${chalk.bold("Updated:")} ${new Date(mergeRequest.updated_at).toLocaleString()}`);
        console.log(`${chalk.bold("URL:")} ${mergeRequest.web_url}`);

        if (mergeRequest.description) {
            console.log(`\n${chalk.bold("Description:")}`);
            console.log(mergeRequest.description);
        }

        if (mergeRequest.labels && mergeRequest.labels.length > 0) {
            console.log(`\n${chalk.bold("Labels:")} ${mergeRequest.labels.join(", ")}`);
        }

        logger.info(`\n${chalk.green("✓")} Successfully retrieved merge request information!`);
    } catch (error: any) {
        if (error.message?.includes("401") || error.message?.includes("Unauthorized")) {
            logger.error(`${chalk.red("✖")} Authentication failed. Please check your access token and try again.`);
            logger.error(`Make sure your token has the required scopes: ${chalk.yellow("read_api, read_repository")}`);
        } else if (error.message?.includes("403") || error.message?.includes("Forbidden")) {
            logger.error(
                `${chalk.red("✖")} Access forbidden. Your token may not have permission to access this project.`
            );
        } else if (error.message?.includes("404") || error.message?.includes("Not Found")) {
            logger.error(
                `${chalk.red(
                    "✖"
                )} Merge request or project not found. Please check the project ID/path and merge request number.`
            );
        } else {
            logger.error(`${chalk.red("✖")} Error: ${error.message}`);
        }
        process.exit(1);
    }
}

// Run the tool
main().catch((err) => {
    logger.error(`\n${chalk.red("✖")} Unexpected error: ${err}`);
    process.exit(1);
});
