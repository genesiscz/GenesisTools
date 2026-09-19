import { realpathSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";

export function sandboxCommand({
    cmd,
    directory,
    readPaths,
}: {
    cmd: string[];
    directory: string;
    readPaths: string[];
}): string[] {
    if (process.platform !== "darwin" || !Bun.which("sandbox-exec")) {
        throw new Error("Unconstrained execution requires the macOS sandbox. Use grammar mode on this platform.");
    }

    const executable = realpathSync(cmd[0]);
    const dir = realpathSync(directory);
    const allowed = [
        "/System",
        "/usr/lib",
        "/usr/share",
        "/Library",
        "/private/etc",
        "/private/var/db",
        "/dev",
        ...readPaths.map((item) => realpathSync(item)),
        dir,
    ];
    const quote = (value: string) => SafeJSON.stringify(value);
    const profile = [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        "(deny process-fork)",
        `(deny process-exec (require-not (literal ${quote(executable)})))`,
        `(deny file-read-data (require-not (require-any ${allowed.map((item) => `(subpath ${quote(item)})`).join(" ")} (literal "/") (literal ${quote(executable)}))))`,
        `(deny file-write* (require-not (require-any (subpath ${quote(dir)}) (literal "/dev/null") (subpath "/dev/fd"))))`,
    ].join("\n");
    return ["/usr/bin/sandbox-exec", "-p", profile, executable, ...cmd.slice(1)];
}
