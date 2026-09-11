#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = Bun.argv.slice(2);

if (args.includes("--help")) {
    console.log(
        "Usage: bun check-help.ts [--repo PATH] [--peekaboo] [--out-dir PATH]\nChecks documented control help and optionally Peekaboo help. Executes no desktop actions. Without --repo, uses tools on PATH."
    );
    process.exit(0);
}

let repo: string | undefined;
let output: string | undefined;
let peekaboo = false;

for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--peekaboo") {
        peekaboo = true;
    } else if ((arg === "--repo" || arg === "--out-dir") && args[index + 1] && !args[index + 1].startsWith("--")) {
        const value = resolve(args[++index]);

        if (arg === "--repo") {
            repo = value;
        } else {
            output = value;
        }
    } else {
        throw new Error(`Unknown or incomplete option: ${arg}`);
    }
}

const entry = repo ? resolve(repo, "src/control/index.ts") : undefined;

if (entry && !existsSync(entry)) {
    throw new Error(`No control entrypoint at ${entry}`);
}

const control = entry ? ["bun", entry] : ["tools", "control"];
const probes = [
    {
        argv: [...control, "see", "--help"],
        command: "control see",
        flags: ["--app", "--window-index", "--window-id", "--depth", "--path", "--scope", "--since"],
    },
    {
        argv: [...control, "act", "--help"],
        command: "control act",
        flags: [
            "--app",
            "--snapshot",
            "--element",
            "--action",
            "--value",
            "--ax-action",
            "--refresh",
            "--path",
            "--direction",
            "--text",
            "--keys",
            "--double",
            "--coords",
            "--background",
            "--button",
            "--to",
            "--duration",
            "--pages",
            "--pixels",
            "--range",
            "--prefix",
            "--suffix",
            "--selection",
            "--format",
        ],
    },
    {
        argv: [...control, "cursor", "move", "--help"],
        command: "control cursor move",
        flags: ["--app", "--snapshot", "--coords", "--name"],
    },
    { argv: [...control, "cursor", "show", "--help"], command: "control cursor show", flags: ["--name"] },
    {
        argv: [...control, "cursor", "click", "--help"],
        command: "control cursor click",
        flags: ["--name", "--snapshot", "--button", "--double"],
    },
    { argv: [...control, "capture", "--help"], command: "control capture", flags: [] },
    { argv: [...control, "capture", "preflight", "--help"], command: "control capture preflight", flags: ["--app"] },
];

if (peekaboo) {
    probes.push(
        {
            argv: ["peekaboo", "see", "--help"],
            command: "peekaboo see",
            flags: ["--app", "--window-id", "--path", "--json"],
        },
        { argv: ["peekaboo", "click", "--help"], command: "peekaboo click", flags: ["--snapshot", "--on", "--json"] },
        { argv: ["peekaboo", "window", "list", "--help"], command: "peekaboo window list", flags: ["--app", "--json"] },
        { argv: ["peekaboo", "capture", "live", "--help"], command: "peekaboo capture live", flags: ["--duration"] }
    );
}

if (output) {
    mkdirSync(output, { recursive: true });
}

for (const probe of probes) {
    const result = Bun.spawnSync(probe.argv, { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const text = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);

    if (result.exitCode !== 0 || !text.includes(probe.command)) {
        throw new Error(`${probe.command}: help failed or returned a different command's help\n${text}`);
    }

    for (const flag of probe.flags) {
        if (!new RegExp(`${flag}(?=[\\s,=])`).test(text)) {
            throw new Error(`${probe.command}: missing documented flag ${flag}`);
        }
    }

    if (output) {
        writeFileSync(resolve(output, `${probe.command.replaceAll(" ", "-")}.txt`), text);
    }

    console.log(`PASS ${probe.command}: ${probe.flags.length} documented flags`);
}

console.log(`${probes.length} help contracts verified. This proves syntax, not live UI behavior.`);
