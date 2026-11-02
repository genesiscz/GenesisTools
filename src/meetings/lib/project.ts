import { isInteractive } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { logger } from "@genesiscz/utils/logger";
import {
    type MeetingsConfigStore,
    matchProjects,
    type ProjectMatchFacts,
    projectNameSchema,
} from "@genesiscz/utils/meetings/config";
import * as p from "@genesiscz/utils/prompts/p";

const { log } = logger.scoped("meetings-project");

const NEW_PROJECT = "\u0000new";
const NO_PROJECT = "\u0000none";

export interface ResolvedProject {
    project?: string;
    how: "flag" | "current" | "match" | "picked" | "none";
}

/**
 * The project for a meeting, in this order: `--project` (a new name joins the known projects), the meeting's own,
 * one matching rule, a choice in a terminal (matches first, then the rest, then "New project…"), and without a
 * terminal no project, so a recording never waits for a prompt.
 */
export async function resolveProject(options: {
    config: MeetingsConfigStore;
    flag?: string;
    current?: string;
    facts?: ProjectMatchFacts;
    /** Never prompt, even in a terminal (the daemon, `--yes`). */
    quiet?: boolean;
}): Promise<ResolvedProject> {
    if (options.flag) {
        projectNameSchema.parse(options.flag);

        if (await options.config.addProject(options.flag)) {
            ui.ok(`Added project ${options.flag} to the known projects.`);
        }

        return { project: options.flag, how: "flag" };
    }

    if (options.current) {
        return { project: options.current, how: "current" };
    }

    const config = await options.config.read();
    const matched = matchProjects(config, options.facts ?? {});
    log.debug({ matched, facts: options.facts }, "project match");

    if (matched.length === 1) {
        return { project: matched[0], how: "match" };
    }

    if (options.quiet || !isInteractive()) {
        return { how: "none" };
    }

    const rest = Object.keys(config.projects).filter((name) => !matched.includes(name));
    const picked = await p.select({
        message: "Which project is this meeting for?",
        options: [
            ...matched.map((name) => ({ value: name, label: name, hint: "matches" })),
            ...rest.map((name) => ({ value: name, label: name })),
            { value: NEW_PROJECT, label: "New project…" },
            { value: NO_PROJECT, label: "No project for now" },
        ],
    });

    if (p.isCancel(picked) || picked === NO_PROJECT) {
        return { how: "none" };
    }

    if (picked !== NEW_PROJECT) {
        return { project: String(picked), how: "picked" };
    }

    const name = await p.text({
        message: "Project name",
        validate: (value) => {
            const parsed = projectNameSchema.safeParse(value ?? "");
            return parsed.success ? undefined : parsed.error.issues[0]?.message;
        },
    });

    if (p.isCancel(name)) {
        return { how: "none" };
    }

    await options.config.addProject(name);
    ui.ok(`Added project ${name} to the known projects.`);
    return { project: name, how: "picked" };
}
