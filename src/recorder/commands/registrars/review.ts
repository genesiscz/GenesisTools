import { parseTime } from "@app/recorder/commands/registrars/parse";
import { commentOn, commentsOf, importBoardComments, resolveComment, uncomment } from "@app/recorder/lib/review";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

const reviewFail = (error: unknown) => {
    out.printlnErr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
};

export function register(program: Command): void {
    const commentCommand = program
        .command("comment")
        .description(
            "Add a review comment at a time of the edit (OUTPUT seconds or m:ss, what plays); the editor shows it as a marker on the timeline. `comment add <recording> <at> <text>` is the same command"
        )
        .argument("<recording>", "a library id, `last`, `open` or a recording folder")
        .argument("<at>", "where it is: seconds, m:ss or h:mm:ss of what plays")
        .argument("<text>", "the comment")
        .option("--to <time>", "the end of the commented range")
        .option("--author <name>", "who wrote it")
        .option(
            "--link <url>",
            "the page it came from: a vitrinka annotation's link, a board's link (with --annotation), a PR"
        )
        .option("--annotation <number>", "the annotation's number on the board --link names: the comment opens it")
        .option("--source", "at and --to are times of the recording itself, not of the edit")
        .option(
            "--export",
            "at and --to are times of the exported file, as its player shows them (the intro card first); a time on a card goes onto the movie"
        )
        // `comment add …` is taken here, not as a subcommand: commander would give an `add` subcommand's options to
        // `comment` itself, which has the same ones.
        .allowExcessArguments()
        .action(
            async (
                _recording: string,
                _at: string,
                _text: string,
                flags: {
                    to?: string;
                    author?: string;
                    link?: string;
                    annotation?: string;
                    source?: boolean;
                    export?: boolean;
                },
                command: Command
            ) => {
                try {
                    const words = command.args;
                    const named = words[0] === "add" ? words.slice(1) : words;

                    if (named.length !== 3) {
                        throw new Error(
                            `comment${words[0] === "add" ? " add" : ""} takes <recording> <at> <text>, not ${named.length} words; quote a comment that has spaces`
                        );
                    }

                    if (flags.annotation !== undefined && !/^\d+$/.test(flags.annotation)) {
                        throw new Error(`--annotation takes the annotation's number, not "${flags.annotation}"`);
                    }

                    if (flags.source && flags.export) {
                        throw new Error("--source and --export name two clocks; give one");
                    }

                    const [value, at, text] = named;
                    out.result(
                        await commentOn(value, {
                            at: parseTime(at, "<at>"),
                            to: flags.to === undefined ? undefined : parseTime(flags.to, "--to"),
                            text,
                            author: flags.author,
                            link: flags.link,
                            annotation: flags.annotation === undefined ? undefined : Number(flags.annotation),
                            clock: flags.export ? "export" : undefined,
                            source: flags.source,
                        })
                    );
                } catch (error) {
                    reviewFail(error);
                }
            }
        );

    commentCommand
        .command("import")
        .description(
            "Import a vitrinka board's annotations as review comments: each annotation on a shot, movie or step card (or on one --card) at the time its text starts with (0:42, 1:02:03, 42s), read on the exported file the board shows (the intro card's length comes off; a time on a card goes onto the movie with a note), else at 0:00 with a note; a second import adds nothing"
        )
        .argument("<recording>", "a library id, `last`, `open` or a recording folder")
        .argument("<board>", "the board's link (a ?card= link picks that card), <workspace>/<slug> or its slug")
        .option("--card <id>", "only this card's annotations")
        .option("--dry-run", "read the board and show what would be added, write nothing")
        .action(async (value: string, board: string, flags: { card?: string; dryRun?: boolean }) => {
            try {
                if (flags.card !== undefined && !/^\d+$/.test(flags.card)) {
                    throw new Error(`--card takes a card id (a number), not "${flags.card}"`);
                }

                out.result(
                    await importBoardComments(value, {
                        board,
                        card: flags.card === undefined ? undefined : Number(flags.card),
                        dryRun: flags.dryRun,
                    })
                );
            } catch (error) {
                reviewFail(error);
            }
        });

    program
        .command("comments")
        .description("A recording's review comments in time order, with where each plays in the edit")
        .argument("<recording>", "a library id, `last`, `open` or a recording folder")
        .action(async (value: string) => {
            try {
                out.result(await commentsOf(value));
            } catch (error) {
                reviewFail(error);
            }
        });

    program
        .command("resolve")
        .description("Mark a review comment done (--reopen opens it again)")
        .argument("<recording>", "a library id, `last`, `open` or a recording folder")
        .argument("<id>", `the comment's id (${toolCommand("recorder comments")} lists them)`)
        .option("--reopen", "open it again")
        .action(async (value: string, id: string, flags: { reopen?: boolean }) => {
            try {
                out.result(await resolveComment(value, id, !flags.reopen));
            } catch (error) {
                reviewFail(error);
            }
        });

    program
        .command("uncomment")
        .description("Remove a review comment")
        .argument("<recording>", "a library id, `last`, `open` or a recording folder")
        .argument("<id>", "the comment's id")
        .action(async (value: string, id: string) => {
            try {
                out.result(await uncomment(value, id));
            } catch (error) {
                reviewFail(error);
            }
        });
}
