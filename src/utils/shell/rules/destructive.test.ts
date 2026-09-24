import { describe, expect, it } from "bun:test";
import { destructiveRules } from "./destructive";
import { detectShellViolations, type ShellViolation } from "./index";

function ids(command: string): string[] {
    return detectShellViolations(command, destructiveRules).map((v) => v.ruleId);
}

function only(command: string, ruleId: string): ShellViolation | undefined {
    return detectShellViolations(command, destructiveRules).find((v) => v.ruleId === ruleId);
}

const MIGRATE = "migrate-fresh-outside-testing";
const DOCKER = "docker-volume-destroy";

describe("migrate-fresh-outside-testing", () => {
    it("fires on the bare form, matched from the command word", () => {
        const command = "cd api && php artisan migrate:fresh --seed";
        const v = only(command, MIGRATE);

        expect(v?.severity).toBe("block");
        expect(v?.matched).toBe("php artisan migrate:fresh --seed");
        expect(v?.index).toBe(command.indexOf("php"));
        expect(v?.suggestion).toBeUndefined();
    });

    it("fires when only one of the two testing flags is present", () => {
        expect(ids("php artisan migrate:fresh --env=testing")).toEqual([MIGRATE]);
        expect(ids("php artisan migrate:fresh --database=testing")).toEqual([MIGRATE]);
    });

    it("fires through sail, docker compose exec and wrappers", () => {
        expect(ids("./vendor/bin/sail artisan migrate:fresh")).toEqual([MIGRATE]);
        expect(ids("docker compose exec app php artisan migrate:fresh")).toEqual([MIGRATE]);
        expect(ids("sudo -u www php artisan migrate:fresh")).toEqual([MIGRATE]);
    });

    it("the only allowed form passes", () => {
        expect(ids("php artisan migrate:fresh --env=testing --database=testing")).toEqual([]);
        expect(ids("php artisan migrate:fresh --database=testing --env=testing --seed")).toEqual([]);
    });

    it("other migrate commands pass", () => {
        expect(ids("php artisan migrate")).toEqual([]);
        expect(ids("php artisan migrate:rollback --step=1")).toEqual([]);
        expect(ids("php artisan migrate:status")).toEqual([]);
    });

    it("prose", () => {
        expect(ids("echo 'never migrate:fresh'")).toEqual([]);
        expect(ids('git commit -m "docs: migrate:fresh is banned"')).toEqual([]);
        expect(ids("rg 'migrate:fresh' docs")).toEqual([]);
        expect(ids("# php artisan migrate:fresh\nphp artisan migrate")).toEqual([]);
    });
});

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
