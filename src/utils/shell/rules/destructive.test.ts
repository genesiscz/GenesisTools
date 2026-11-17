import { describe, expect, it } from "bun:test";
import { constants } from "node:os";
import { destructiveRules } from "./destructive";
import { detectShellViolations, type ShellViolation } from "./index";

function ids(command: string): string[] {
    return detectShellViolations(command, destructiveRules).map((v) => v.ruleId);
}

function only(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command, destructiveRules).find((v) => v.ruleId === ruleId);
}

const DOCKER = "docker-volume-destroy";

describe("docker-volume-destroy", () => {
    it("volume rm / prune / remove", () => {
        const v = only("docker volume rm pg_data", DOCKER);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("docker volume rm pg_data");
        expect(v?.suggestion).toBeUndefined();
        expect(ids("docker volume prune -f")).toEqual([DOCKER]);
        expect(ids("docker volume remove x")).toEqual([DOCKER]);
    });

    it("system prune with volumes", () => {
        expect(ids("docker system prune -av")).toEqual([DOCKER]);
        expect(ids("docker system prune --volumes")).toEqual([DOCKER]);
        expect(ids("docker system prune -a --volumes -f")).toEqual([DOCKER]);
    });

    it("system prune without volumes keeps them, so it passes", () => {
        expect(ids("docker system prune")).toEqual([]);
        expect(ids("docker system prune -a")).toEqual([]);
        expect(ids("docker system prune -af")).toEqual([]);
    });

    it("rm with force AND volumes, in either spelling", () => {
        expect(ids("docker rm -fv app")).toEqual([DOCKER]);
        expect(ids("docker rm -f -v app")).toEqual([DOCKER]);
        expect(ids("docker rm -vf app")).toEqual([DOCKER]);
        expect(ids("docker container rm -fv app")).toEqual([DOCKER]);
    });

    it("sees the subcommand past docker's global options", () => {
        expect(ids("docker --context orbstack volume prune -f")).toEqual([DOCKER]);
        expect(ids("docker -H tcp://host volume rm pg_data")).toEqual([DOCKER]);
        expect(ids("docker --log-level debug system prune --volumes")).toEqual([DOCKER]);
        expect(ids("docker --context orbstack volume ls")).toEqual([]);
    });

    it("compose down with volumes is caught in both spellings", () => {
        expect(ids("docker compose down -v")).toEqual([DOCKER]);
        expect(ids("docker compose down --volumes")).toEqual([DOCKER]);
        expect(ids("docker compose -f stack.yml down -v")).toEqual([DOCKER]);
        expect(ids("docker-compose down -v")).toEqual([DOCKER]);
        expect(ids("docker-compose down")).toEqual([]);
    });

    it("rm with only one of the two flags passes", () => {
        expect(ids("docker rm -f app")).toEqual([]);
        expect(ids("docker rm -v app")).toEqual([]);
        expect(ids("docker rm app")).toEqual([]);
    });

    it("read-only docker commands pass", () => {
        expect(ids("docker volume ls")).toEqual([]);
        expect(ids("docker volume inspect pg_data")).toEqual([]);
        expect(ids("docker ps -a")).toEqual([]);
        expect(ids("docker image prune -a")).toEqual([]);
        expect(ids("docker compose down")).toEqual([]);
    });

    it("through a wrapper and later in a chain, matched from the docker word", () => {
        const command = "docker ps; sudo docker volume rm 'my vol'";
        const v = only(command, DOCKER);

        expect(v?.index).toBe(command.indexOf("docker volume"));
        expect(v?.matched).toBe("docker volume rm 'my vol'");
    });

    it("prose", () => {
        expect(ids("echo 'docker volume rm x'")).toEqual([]);
        expect(ids("cat <<'EOF'\ndocker volume prune\nEOF")).toEqual([]);
        expect(ids("# docker system prune -av\ndocker ps")).toEqual([]);
    });
});

describe("docker's long flag spellings", () => {
    // `flags` used to keep only short clusters, so the long spelling escaped a rule the
    // short one tripped, while the prune branch already accepted `--volumes`.
    const caught = [
        "docker rm --force --volumes app",
        "docker rm --volumes --force app",
        "docker container rm --force --volumes app",
        "docker rm -f --volumes app",
        "docker system prune --volumes",
    ];

    it.each(caught)("catches %j", (command) => {
        expect(detectShellViolations(command).map((violation) => violation.ruleId)).toContain("docker-volume-destroy");
    });

    const allowed = ["docker rm --force app", "docker rm app", "docker system prune", "docker ps --all"];

    it.each(allowed)("leaves %j alone", (command) => {
        expect(detectShellViolations(command).map((violation) => violation.ruleId)).not.toContain(
            "docker-volume-destroy"
        );
    });
});

const WAKE = "stopped-job-wake";
// 19 on macOS, 18 on Linux: the rule reads the number of the platform it runs on.
const CONT_NUMBER = String(constants.signals.SIGCONT);

describe("stopped-job-wake", () => {
    it("blocks the 2026-11-17 loop that ended stopped Claude jobs with TERM and CONT", () => {
        const command =
            "for L in 1 2; do g=$(ps -o pgid= -p $L | tr -d ' '); " +
            '[ -n "$g" ] && { kill -TERM -"$g"; kill -CONT -"$g"; }; done';
        const v = only(command, WAKE);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe('kill -CONT -"$g"');
        expect(v?.index).toBe(command.indexOf("kill -CONT"));
        expect(v?.detail).toBe("SIGCONT to the process group -$g");
        expect(detectShellViolations(command).map((violation) => violation.ruleId)).toContain(WAKE);
    });

    const woken = [
        "kill -CONT -1234",
        "kill -SIGCONT -1234",
        "kill -cont -1234",
        "kill -s CONT -1234",
        "kill -s SIGCONT -- -1234",
        "kill --signal CONT -1234",
        `kill -${CONT_NUMBER} -1234`,
        "kill -CONT -- -1234",
        "kill -CONT 55 -1234",
        "sudo /bin/kill -CONT -$PG",
        "kill -CONT \"-$(ps -o pgid= -p 5 | tr -d ' ')\"",
        'bash -c "kill -CONT -77"',
        "ps -p 1; kill -CONT -$pg && echo done",
    ];

    it.each(woken)("blocks %j", (command) => {
        expect(ids(command)).toEqual([WAKE]);
    });

    const passed = [
        "kill -CONT 1234",
        "kill -CONT -- 1234",
        "kill -TERM -1234",
        "kill -KILL -1234",
        "kill -s KILL -1234",
        "kill -l CONT",
        "kill 1234",
        "echo 'kill -CONT -12'",
        "cat <<'EOF'\nkill -CONT -12\nEOF",
        "# kill -CONT -12\nps -p 1",
    ];

    it.each(passed)("passes %j", (command) => {
        expect(ids(command)).toEqual([]);
    });
});
