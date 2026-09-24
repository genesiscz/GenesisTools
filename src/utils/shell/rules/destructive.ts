// Irreversible operations CLAUDE.md forbids outright.

import { commandTokenIndex, commandWord, originalSlice, splitPipeline, tokenize } from "../scan";
import type { ShellMatch, ShellRule } from "./types";

export const migrateFreshOutsideTesting: ShellRule = {
    id: "migrate-fresh-outside-testing",
    kind: "destructive",
    title: "migrate:fresh drops every table; only the testing database may run it",
    severity: "block",
    why:
        "`migrate:fresh` drops all tables and re-runs migrations. Against the development or production " +
        "database that is data loss with no undo. The only allowed form names the testing connection " +
        "explicitly with both `--env=testing` and `--database=testing`, and even that needs the user's yes.",
    wrong: "php artisan migrate:fresh --seed",
    right: "php artisan migrate:fresh --env=testing --database=testing --seed   # after an explicit yes",
    evidence:
        "4 mentions in 30 days: 3 in prose, 1 already in the testing form. Kept because the cost is the whole database.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const idx = tokens.findIndex((t) => t.text === "migrate:fresh");

                    if (idx === -1) {
                        continue;
                    }

                    const texts = tokens.map((t) => t.text);

                    if (texts.includes("--env=testing") && texts.includes("--database=testing")) {
                        continue;
                    }

                    const cmd = commandTokenIndex(tokens);
                    const start = cmd === -1 ? tokens[idx].start : tokens[cmd].start;
                    return { matched: originalSlice(scan, start, element.start + element.text.length), index: start };
                }
            }
        }

        return null;
    },
};

/** Docker global options that consume the next token, in their separate-value spelling. */
const DOCKER_GLOBAL_WITH_VALUE = new Set([
    "-H",
    "--host",
    "-c",
    "--context",
    "--config",
    "-l",
    "--log-level",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
]);

// docker volume rm|prune, docker system prune, docker rm with -f and -v, compose down -v.
export const dockerVolumeDestroy: ShellRule = {
    id: "docker-volume-destroy",
    kind: "destructive",
    title: "docker volume rm / prune and rm -fv delete data with no snapshot to recover",
    severity: "block",
    why:
        "OrbStack and Docker Desktop do not snapshot volumes. `docker volume rm`, `docker volume prune`, " +
        "`docker system prune` (with volumes), `docker rm -fv` and `docker compose down -v` delete the " +
        "database files inside the " +
        "volume, and recovery is generally impossible. Even a volume that looks broken needs an explicit yes.",
    wrong: "docker volume prune -f",
    right: "docker volume ls   # list, then ask before removing anything by name",
    evidence: "0 uses in 30 days; CLAUDE.md marks it 🛑 because there is no undo.",
    detect(scan): ShellMatch | null {
        for (const statements of scan.units) {
            for (const statement of statements) {
                for (const element of splitPipeline(statement)) {
                    const tokens = tokenize(element);
                    const cmd = commandTokenIndex(tokens);

                    const word = cmd === -1 ? "" : commandWord(tokens[cmd].text);

                    if (word !== "docker" && word !== "docker-compose") {
                        continue;
                    }

                    // Docker's global options come before the subcommand, and some take a value:
                    // `docker --context orbstack volume prune` read `orbstack` as the subcommand, so
                    // the volume deletion passed. They are skipped the way `git -C dir` is.
                    const all = tokens.slice(cmd + 1).map((t) => t.text);
                    let first = 0;

                    while (word === "docker" && first < all.length && all[first].startsWith("-")) {
                        first += DOCKER_GLOBAL_WITH_VALUE.has(all[first]) ? 2 : 1;
                    }

                    const args = all.slice(first);
                    const positional = args.filter((a) => !a.startsWith("-"));
                    const shortFlags = args.filter((a) => a.startsWith("-") && !a.startsWith("--"));
                    const [a, b] = positional;
                    // Both spellings, for both flags. `shortFlags` kept only `-fv`-style
                    // clusters, so `docker rm --force --volumes app` — which deletes exactly
                    // the same data — was never detected, while the prune branch below
                    // already accepted `--volumes`. The two paths disagreed.
                    const hasForce = shortFlags.some((f) => f.includes("f")) || args.includes("--force");
                    const hasVolumes = shortFlags.some((f) => f.includes("v")) || args.includes("--volumes");
                    const forceAndVolumes = hasForce && hasVolumes;
                    // `docker system prune` alone keeps volumes since Docker 23; only
                    // `--volumes` (or a `v` in a short cluster) reaches them.
                    const pruneVolumes = hasVolumes;
                    // `compose down -v` removes the project's named volumes: the most common way
                    // to lose a Compose database. `down` is searched, not taken by position,
                    // because `compose -f stack.yml down -v` puts the file name first.
                    const composeDown =
                        (word === "docker" && a === "compose" && positional.includes("down")) ||
                        (word === "docker-compose" && positional.includes("down"));
                    const destructive =
                        (composeDown && hasVolumes) ||
                        (word === "docker" &&
                            ((a === "volume" && (b === "rm" || b === "prune" || b === "remove")) ||
                                (a === "system" && b === "prune" && pruneVolumes) ||
                                (a === "rm" && forceAndVolumes) ||
                                (a === "container" && b === "rm" && forceAndVolumes)));

                    if (!destructive) {
                        continue;
                    }

                    const start = tokens[cmd].start;
                    return { matched: originalSlice(scan, start, element.start + element.text.length), index: start };
                }
            }
        }

        return null;
    },
};

export const destructiveRules: readonly ShellRule[] = [migrateFreshOutsideTesting, dockerVolumeDestroy];
