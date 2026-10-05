import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    EVENT_CATEGORIES,
    EVENT_TYPE_NAMES,
    eventNameForType,
    KNOWN_EVENTS,
    parseEventList,
    resolveEventSelection,
    splitNames,
    supportedEvents,
} from "./events";
import { compileFilter, FilterSyntaxError } from "./filter";
import { describeExitStatus, formatEvent } from "./format";
import { auditTokenField, eventNameOf, parseEsloggerLine, valueAtPath } from "./message";
import {
    type CaptureProcess,
    classifyStderr,
    esloggerInvocation,
    explainStderr,
    rootRequiredMessage,
    runLiveCapture,
} from "./run";
import { EventStream } from "./stream";

/**
 * Lines shaped like real eslogger output (schema_version 1): `event_type` is the es_event_type_t
 * number, `event` nests the payload under the short name, and message version 10 writes audit
 * tokens as positional arrays [auid, euid, egid, ruid, rgid, pid, asid, pidversion]. The stat blocks
 * are trimmed; pids, paths and users are invented.
 */
const token = (pid: number, euid = 501) => ({
    auid: 501,
    euid,
    egid: 20,
    ruid: euid,
    rgid: 20,
    pid,
    asid: 100017,
    pidversion: 4242,
});

const esProcess = (pid: number, path: string, euid = 501) => ({
    audit_token: token(pid, euid),
    ppid: 700,
    original_ppid: 700,
    is_platform_binary: true,
    team_id: null,
    signing_id: "com.example.tool",
    executable: { path, path_truncated: false },
    tty: null,
});

const line = (value: unknown) => SafeJSON.stringify(value, { strict: true });

const EXEC = line({
    schema_version: 1,
    version: 9,
    event_type: 9,
    time: "2026-10-05T08:15:30.123456789Z",
    process: esProcess(4100, "/bin/zsh"),
    event: {
        exec: {
            target: esProcess(4100, "/usr/bin/git"),
            args: ["git", "commit", "-m", "two words"],
            env: ["PATH=/usr/bin:/bin"],
            cwd: { path: "/Users/alice/project", path_truncated: false },
            script: null,
            dyld_exec_path: "/usr/bin/git",
            fds: [{ fd: 0, fdtype: 1 }],
            last_fd: 2,
        },
    },
});

const FORK_POSITIONAL = line({
    schema_version: 1,
    version: 10,
    event_type: 11,
    time: "2026-10-05T08:15:31.000000000Z",
    process: { audit_token: [501, 501, 20, 501, 20, 4200, 100013, 38282], executable: { path: "/bin/zsh" } },
    event: {
        fork: {
            child: { audit_token: [501, 501, 20, 501, 20, 4201, 100013, 38283], executable: { path: "/bin/zsh" } },
        },
    },
});

const EXIT = line({
    schema_version: 1,
    version: 9,
    event_type: 15,
    time: "2026-10-05T08:15:32.000000000Z",
    process: esProcess(4300, "/usr/sbin/ipconfig", 0),
    event: { exit: { stat: 256 } },
});

const OPEN = line({
    schema_version: 1,
    event_type: 10,
    time: "2026-10-05T08:15:33.000Z",
    process: esProcess(4400, "/Applications/Editor.app/Contents/MacOS/Editor"),
    event: { open: { fflag: 3, file: { path: "/Users/alice/notes.txt", path_truncated: false } } },
});

describe("event catalogue", () => {
    it("lists 104 unique, sorted short names", () => {
        expect(KNOWN_EVENTS.length).toBe(104);
        expect(new Set(KNOWN_EVENTS).size).toBe(104);
        expect([...KNOWN_EVENTS].sort()).toEqual([...KNOWN_EVENTS]);
    });

    it("maps event_type numbers to exactly the known events", () => {
        expect(Object.values(EVENT_TYPE_NAMES).sort()).toEqual([...KNOWN_EVENTS]);
    });

    // Regression: the old table stopped at 146 = ES_EVENT_TYPE_LAST and carried a made-up 90210.
    it("names the macOS 15 events and drops the stale entries", () => {
        expect(eventNameForType(9)).toBe("exec");
        expect(eventNameForType(146)).toBe("gatekeeper_user_override");
        expect(eventNameForType(147)).toBe("tcc_modify");
        expect(eventNameForType(90210)).toBe("event_type_90210");
        expect(eventNameForType(0)).toBe("event_type_0");
    });

    it("puts only real events in categories", () => {
        for (const [name, category] of Object.entries(EVENT_CATEGORIES)) {
            const unknown = category.events.filter((event) => !KNOWN_EVENTS.includes(event));
            expect({ name, unknown }).toEqual({ name, unknown: [] });
        }
    });

    it("resolves categories and events into one deduplicated list", () => {
        const selection = resolveEventSelection({
            categories: ["process"],
            events: ["exec", "open"],
            supported: KNOWN_EVENTS,
        });
        expect(selection.events).toEqual(["exec", "fork", "exit", "open"]);
        expect(selection.unknownEvents).toEqual([]);
    });

    it("reports unknown names and a prototype key as an unknown category", () => {
        const selection = resolveEventSelection({
            categories: ["network", "constructor"],
            events: ["exec", "bogus"],
            supported: KNOWN_EVENTS,
        });
        expect(selection.unknownCategories).toEqual(["network", "constructor"]);
        expect(selection.unknownEvents).toEqual(["bogus"]);
        expect(selection.events).toEqual(["exec"]);
    });

    it("leaves out a category member an older eslogger lacks, and still refuses an event named with -e", () => {
        const older = KNOWN_EVENTS.filter((name) => name !== "gatekeeper_user_override" && name !== "tcc_modify");
        const viaCategory = resolveEventSelection({ categories: ["security", "auth"], supported: older });

        expect(viaCategory.unknownEvents).toEqual([]);
        expect(viaCategory.skippedEvents).toEqual(["gatekeeper_user_override", "tcc_modify"]);
        expect(viaCategory.events).toContain("sudo");
        expect(viaCategory.events).toContain("authorization_petition");
        expect(viaCategory.events).not.toContain("tcc_modify");

        const named = resolveEventSelection({ categories: ["auth"], events: ["tcc_modify"], supported: older });
        expect(named.unknownEvents).toEqual(["tcc_modify"]);
        expect(named.skippedEvents).toEqual([]);
    });

    it("keeps no event when no member of the category is supported", () => {
        const selection = resolveEventSelection({ categories: ["persistence"], supported: ["exec"] });

        expect(selection.events).toEqual([]);
        expect(selection.unknownEvents).toEqual([]);
        expect(selection.skippedEvents).toEqual([...EVENT_CATEGORIES.persistence.events]);
    });

    it("adds fork beside exec only when asked", () => {
        expect(resolveEventSelection({ events: ["exec"], includeFork: true, supported: KNOWN_EVENTS })).toMatchObject({
            events: ["exec", "fork"],
            addedFork: true,
        });
        expect(resolveEventSelection({ events: ["exec"], supported: KNOWN_EVENTS }).events).toEqual(["exec"]);
    });

    it("splits flag values on commas and spaces", () => {
        expect(splitNames(" exec, Fork  exit,")).toEqual(["exec", "fork", "exit"]);
        expect(splitNames(undefined)).toEqual([]);
    });

    it("prefers the live --list-events output and falls back to the built-in list", () => {
        expect(supportedEvents(() => "exec\nfork\npaste\n")).toEqual({
            events: ["exec", "fork", "paste"],
            source: "eslogger",
        });
        expect(supportedEvents(() => null).source).toBe("built-in");
        expect(supportedEvents(() => "usage: eslogger ...").source).toBe("built-in");
        expect(parseEventList("exec\n\n  open \nNot An Event\n")).toEqual(["exec", "open"]);
    });
});

describe("message parsing and paths", () => {
    it("parses a line and names the event from its single key", () => {
        const parsed = parseEsloggerLine(EXEC);
        expect(parsed.ok).toBe(true);

        if (parsed.ok) {
            expect(eventNameOf(parsed.message)).toBe("exec");
        }
    });

    it("falls back to event_type when the event key is missing", () => {
        expect(eventNameOf({ event_type: 147 })).toBe("tcc_modify");
    });

    it("rejects a non-JSON line and a JSON value that is not an object", () => {
        expect(parseEsloggerLine("Launched eslogger").ok).toBe(false);
        expect(parseEsloggerLine("[1,2]").ok).toBe(false);
    });

    it("reads audit tokens in the object form and the positional form", () => {
        expect(auditTokenField(token(77), "pid")).toBe(77);
        expect(auditTokenField([1, 2, 3, 4, 5, 77, 7, 8], "pid")).toBe(77);
        expect(auditTokenField([1, 2, 3, 4, 5, 77, 7, 8], "euid")).toBe(2);
        expect(auditTokenField([1, 2, 3], "pid")).toBeUndefined();
    });

    it("walks dot paths, array indexes and positional audit tokens", () => {
        const exec = SafeJSON.parse(EXEC, { strict: true });
        const fork = SafeJSON.parse(FORK_POSITIONAL, { strict: true });
        expect(valueAtPath(exec, ".event.exec.target.executable.path")).toBe("/usr/bin/git");
        expect(valueAtPath(exec, ".event.exec.args[1]")).toBe("commit");
        expect(valueAtPath(exec, "event.exec.args.3")).toBe("two words");
        expect(valueAtPath(fork, ".process.audit_token.pid")).toBe(4200);
        expect(valueAtPath(fork, ".event.fork.child.audit_token.pid")).toBe(4201);
        expect(valueAtPath(exec, ".event.target.path")).toBeUndefined();
    });
});

describe("filters", () => {
    const exec = SafeJSON.parse(EXEC, { strict: true });
    const exit = SafeJSON.parse(EXIT, { strict: true });

    it("matches the documented exec path with a regex", () => {
        expect(compileFilter('.event.exec.target.executable.path =~ "git$"').test(exec)).toBe(true);
        expect(compileFilter('.event.exec.target.executable.path !~ "git$"').test(exec)).toBe(false);
    });

    // Regression: `==` used to turn into an unanchored regex as soon as the value had a dot in it.
    it("compares == as exact text even when the value contains regex characters", () => {
        const python = { process: { executable: { path: "/usr/bin/python3x11-helper" } } };
        expect(compileFilter('.process.executable.path == "/usr/bin/python3.11"').test(python)).toBe(false);
        expect(compileFilter('.process.executable.path == "/usr/sbin/ipconfig"').test(exit)).toBe(true);
    });

    // Regression: `String(value || "")` turned 0 and false into "", so euid == 0 never matched.
    it("matches zero and false", () => {
        expect(compileFilter(".process.audit_token.euid == 0").test(exit)).toBe(true);
        expect(compileFilter(".process.is_platform_binary == true").test(exit)).toBe(true);
        expect(compileFilter('.event.sudo.success == "false"').test({ event: { sudo: { success: false } } })).toBe(
            true
        );
    });

    it("joins argument arrays so a regex can search them", () => {
        expect(compileFilter('.event.exec.args =~ "commit -m"').test(exec)).toBe(true);
    });

    it("treats a missing path as no match for == and =~, and a match for != and !~", () => {
        expect(compileFilter('.event.exec.script.path == ""').test(exec)).toBe(false);
        expect(compileFilter('.process.tty.path != "/dev/ttys001"').test(exec)).toBe(true);
        expect(compileFilter('.event.exec.nothing !~ "x"').test(exec)).toBe(true);
        expect(compileFilter('.event.exec.nothing =~ "x"').test(exec)).toBe(false);
    });

    it("accepts a single = and single quotes", () => {
        expect(compileFilter(".event.exec.args[0] = 'git'").test(exec)).toBe(true);
    });

    // Regression: the old README filtered on `.event.target.path`, which never matches real eslogger output.
    it("rejects a path that skips the event name, before reading any event", () => {
        expect(() => compileFilter('.event.target.path =~ "bash"')).toThrow(FilterSyntaxError);
        expect(() => compileFilter('.event.file.path !~ "tmp"')).toThrow(/short name/);
    });

    it("rejects an unreadable expression and an invalid regex", () => {
        expect(() => compileFilter("just words")).toThrow(FilterSyntaxError);
        expect(() => compileFilter('.process.executable.path =~ "("')).toThrow(/invalid regular expression/);
    });

    it("names the event a filter reads", () => {
        expect(compileFilter(".event.fork.child.audit_token.pid == 1").eventName).toBe("fork");
        expect(compileFilter(".process.ppid == 1").eventName).toBeUndefined();
    });
});

describe("formatting", () => {
    const format = (raw: string) => formatEvent(SafeJSON.parse(raw, { strict: true }), { timeZone: "UTC" });

    it("shows what an exec started, with its arguments and directory", () => {
        expect(format(EXEC)).toBe(
            "08:15:30.123 exec         pid 4100   /bin/zsh → /usr/bin/git commit -m 'two words' (cwd /Users/alice/project)"
        );
    });

    it("reads parent and child pids from positional audit tokens", () => {
        expect(format(FORK_POSITIONAL)).toBe("08:15:31.000 fork         pid 4200   /bin/zsh → child pid 4201");
    });

    it("decodes the wait status of an exit", () => {
        expect(format(EXIT)).toBe("08:15:32.000 exit         pid 4300   /usr/sbin/ipconfig exit code 1");
        expect(describeExitStatus(0)).toBe("exit code 0");
        expect(describeExitStatus(9)).toBe("killed by SIGKILL");
    });

    it("shows open flags and the file", () => {
        expect(format(OPEN)).toBe(
            "08:15:33.000 open         pid 4400   /Applications/Editor.app/Contents/MacOS/Editor read+write /Users/alice/notes.txt"
        );
    });

    it("shows both rename destination forms", () => {
        const base = { time: "2026-10-05T08:00:00Z", process: esProcess(1, "/bin/mv") };
        const toNew = {
            ...base,
            event: {
                rename: {
                    source: { path: "/tmp/a" },
                    destination_type: 1,
                    destination: { new_path: { dir: { path: "/tmp/dir/" }, filename: "b" } },
                },
            },
        };
        const toExisting = {
            ...base,
            event: {
                rename: {
                    source: { path: "/tmp/a" },
                    destination_type: 0,
                    destination: { existing_file: { path: "/tmp/c" } },
                },
            },
        };
        expect(formatEvent(toNew, { timeZone: "UTC" })).toEndWith("/bin/mv /tmp/a → /tmp/dir/b");
        expect(formatEvent(toExisting, { timeZone: "UTC" })).toEndWith("/bin/mv /tmp/a → /tmp/c");
    });

    it("shows sudo and authentication outcomes", () => {
        const sudo = {
            process: esProcess(5, "/usr/bin/sudo", 0),
            event: {
                sudo: { success: true, from_username: "alice", to_username: "root", command: "/usr/bin/eslogger exec" },
            },
        };
        const auth = {
            process: esProcess(6, "/usr/libexec/opendirectoryd", 0),
            event: { authentication: { success: false, type: 1 } },
        };
        expect(formatEvent(sudo)).toEndWith("ok alice → root: /usr/bin/eslogger exec");
        expect(formatEvent(auth)).toEndWith("FAILED touchid");
    });

    it("falls back to a target path for events without their own layout", () => {
        const readdir = {
            process: esProcess(7, "/usr/bin/find"),
            event: { readdir: { target: { path: "/var/log" } } },
        };
        expect(formatEvent(readdir)).toEndWith("readdir      pid 7      /usr/bin/find /var/log");
    });

    it("never throws on a line with missing fields", () => {
        expect(formatEvent({})).toBe("--:--:--.--- unknown      pid ?      ?");
        expect(formatEvent({ event_type: 31, event: { signal: {} } })).toContain("signal");
    });

    it("builds one time formatter per zone, not one per event", () => {
        const message = SafeJSON.parse(OPEN, { strict: true });
        const construct = spyOn(Intl, "DateTimeFormat");

        try {
            const auckland = Array.from({ length: 50 }, () => formatEvent(message, { timeZone: "Pacific/Auckland" }));

            expect(construct.mock.calls.length).toBeLessThanOrEqual(1);
            expect(new Set(auckland)).toEqual(new Set([auckland[0]]));
            expect(auckland[0]).toStartWith("21:15:33.000 ");
            expect(formatEvent(message, { timeZone: "UTC" })).toStartWith("08:15:33.000 ");
        } finally {
            construct.mockRestore();
        }
    });
});

describe("EventStream", () => {
    it("joins lines and characters split across chunks, filters, and counts", () => {
        const shown: string[] = [];
        const errors: string[] = [];
        const stream = new EventStream({
            filters: [compileFilter('.process.executable.path == "/bin/zsh"')],
            format: { timeZone: "UTC" },
            onEvent: (formatted) => shown.push(formatted),
            onParseError: (_error, raw) => errors.push(raw),
        });
        const bytes = new TextEncoder().encode(
            `${EXEC}\nnot json\n${EXIT}\n${FORK_POSITIONAL.replace("/bin/zsh", "/bin/žsh")}`
        );
        const cut = bytes.indexOf(0xc5) + 1;
        stream.write(bytes.slice(0, 40));
        stream.write(bytes.slice(40, cut));
        stream.write(bytes.slice(cut));
        stream.end();

        expect(shown.length).toBe(1);
        expect(shown[0]).toContain("/usr/bin/git");
        expect(errors).toEqual(["not json"]);
        expect(stream.stats).toEqual({ lines: 4, events: 3, shown: 1, parseErrors: 1 });
    });

    it("keeps only the selected events when replaying a recording", () => {
        const names: string[] = [];
        const stream = new EventStream({
            filters: [],
            events: new Set(["exit"]),
            onEvent: (_formatted, message) => names.push(eventNameOf(message)),
        });
        stream.write(`${EXEC}\n${EXIT}\n${OPEN}\n`);
        stream.end();
        expect(names).toEqual(["exit"]);
    });
});

describe("running eslogger", () => {
    it("raises only eslogger through sudo when not root", () => {
        expect(esloggerInvocation({ events: ["exec"], isRoot: true })).toEqual({
            argv: ["/usr/bin/eslogger", "exec"],
            viaSudo: false,
        });
        const viaSudo = esloggerInvocation({ events: ["exec", "fork"], isRoot: false });
        expect(viaSudo.viaSudo).toBe(true);
        expect(viaSudo.argv.slice(0, 2)).toEqual(["sudo", "-p"]);
        expect(viaSudo.argv.slice(3)).toEqual(["/usr/bin/eslogger", "exec", "fork"]);
    });

    // The strings below are the ones in /usr/bin/eslogger on macOS 26.3.
    it("recognises eslogger's client errors and sudo's", () => {
        expect(
            classifyStderr(
                "Failed to create ES client: Not permitted to create an ES Client, responsible process needs TCC Full Disk Access authorization (ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED)"
            )
        ).toBe("not-permitted");
        expect(
            classifyStderr(
                "Failed to create ES client: Not privileged to create an ES client, need to be superuser (ES_NEW_CLIENT_RESULT_ERR_NOT_PRIVILEGED)"
            )
        ).toBe("not-privileged");
        expect(classifyStderr("Failed to parse event types: nope")).toBe("bad-event");
        expect(classifyStderr("sudo: a terminal is required to read the password")).toBe("sudo");
        expect(classifyStderr("something else")).toBe("other");
        expect(explainStderr("not-permitted", "GenesisTools.app")).toContain("Full Disk Access for GenesisTools.app");
        expect(explainStderr("other", "x")).toBeUndefined();
    });

    it("says what to run and which app needs Full Disk Access", () => {
        const message = rootRequiredMessage({ command: "tools macos eslogger -e exec", fdaSubject: "Terminal" });
        expect(message).toContain("must run as root");
        expect(message).toContain("  tools macos eslogger -e exec");
        expect(message).toContain("Full Disk Access for Terminal");
        expect(message).toContain("permissions open --pane full-disk-access");
    });

    function fakeProcess(stdoutChunks: string[], stderrChunks: string[]) {
        const kills: string[] = [];
        const { promise: exited, resolve: finish } = Promise.withResolvers<number>();
        let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const encoder = new TextEncoder();
        const state: { exitCode: number | null; signalCode: string | null } = { exitCode: null, signalCode: null };
        const child: CaptureProcess = {
            stdout: new ReadableStream<Uint8Array>({
                start(controller) {
                    stdoutController = controller;
                    for (const chunk of stdoutChunks) {
                        controller.enqueue(encoder.encode(chunk));
                    }
                },
            }),
            stderr: new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const chunk of stderrChunks) {
                        controller.enqueue(encoder.encode(chunk));
                    }
                    controller.close();
                },
            }),
            exited,
            get exitCode() {
                return state.exitCode;
            },
            get signalCode() {
                return state.signalCode;
            },
            kill(signal) {
                kills.push(signal ?? "SIGTERM");
                state.signalCode = signal ?? "SIGTERM";
                stdoutController?.close();
                finish(130);
            },
        };
        return { child, kills };
    }

    it("streams stdout into events, stderr into lines, and stops with SIGINT on Ctrl-C", async () => {
        const { child, kills } = fakeProcess(
            [EXEC.slice(0, 30), `${EXEC.slice(30)}\n`],
            ["first warn", "ing\nsecond\n"]
        );
        const shown: string[] = [];
        const stderr: string[] = [];
        const controller = new AbortController();
        const stream = new EventStream({
            filters: [],
            onEvent: (formatted) => {
                shown.push(formatted);
                controller.abort();
            },
        });

        const result = await runLiveCapture({
            invocation: { argv: ["/usr/bin/eslogger", "exec"], viaSudo: false },
            stream,
            signal: controller.signal,
            onStderrLine: (text) => stderr.push(text),
            spawn: () => child,
        });

        expect(shown.length).toBe(1);
        expect(stderr).toEqual(["first warning", "second"]);
        expect(kills).toEqual(["SIGINT"]);
        expect(result).toEqual({ exitCode: null, signalCode: "SIGINT", interrupted: true });
    });

    it("stops eslogger when a stream pump fails, then rethrows that failure", async () => {
        const { child, kills } = fakeProcess([`${EXEC}\n`], []);
        const stream = new EventStream({
            filters: [],
            onEvent: () => {
                throw new Error("stdout is closed");
            },
        });

        await expect(
            runLiveCapture({
                invocation: { argv: ["/usr/bin/eslogger", "exec"], viaSudo: false },
                stream,
                signal: new AbortController().signal,
                onStderrLine: () => {},
                spawn: () => child,
                stopTimeoutMs: 50,
            })
        ).rejects.toThrow("stdout is closed");

        expect(kills).toEqual(["SIGINT"]);
    });

    it("sends SIGTERM, then stops waiting, for an eslogger that ignores SIGINT after a pump failure", async () => {
        const kills: string[] = [];
        const encoder = new TextEncoder();
        const child: CaptureProcess = {
            stdout: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(`${EXEC}\n`));
                },
            }),
            stderr: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.close();
                },
            }),
            exited: new Promise<number>(() => {}),
            exitCode: null,
            signalCode: null,
            kill(signal) {
                kills.push(signal ?? "SIGTERM");
            },
        };
        const stream = new EventStream({
            filters: [],
            onEvent: () => {
                throw new Error("stdout is closed");
            },
        });

        await expect(
            runLiveCapture({
                invocation: { argv: ["/usr/bin/eslogger", "exec"], viaSudo: false },
                stream,
                signal: new AbortController().signal,
                onStderrLine: () => {},
                spawn: () => child,
                stopTimeoutMs: 20,
            })
        ).rejects.toThrow("stdout is closed");

        expect(kills).toEqual(["SIGINT", "SIGTERM"]);
    });

    function stubbornProcess(options: { exitsOn: NodeJS.Signals | null }) {
        const kills: string[] = [];
        const unrefs: string[] = [];
        const encoder = new TextEncoder();
        const { promise: exited, resolve: finish } = Promise.withResolvers<number>();
        let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const state: { exitCode: number | null; signalCode: string | null } = { exitCode: null, signalCode: null };
        const child: CaptureProcess = {
            stdout: new ReadableStream<Uint8Array>({
                start(controller) {
                    stdoutController = controller;
                    controller.enqueue(encoder.encode(EXEC));
                },
            }),
            stderr: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.close();
                },
            }),
            exited,
            get exitCode() {
                return state.exitCode;
            },
            get signalCode() {
                return state.signalCode;
            },
            kill(signal) {
                kills.push(signal ?? "SIGTERM");

                if (signal === options.exitsOn) {
                    state.signalCode = signal;
                    stdoutController?.close();
                    finish(143);
                }
            },
            unref() {
                unrefs.push("unref");
            },
        };

        return { child, kills, unrefs };
    }

    it("stops waiting on Ctrl-C for an eslogger that ignores SIGINT and SIGTERM, and flushes what it read", async () => {
        const { child, kills, unrefs } = stubbornProcess({ exitsOn: null });
        const shown: string[] = [];
        const stream = new EventStream({ filters: [], onEvent: (formatted) => shown.push(formatted) });
        const aborted = new AbortController();
        aborted.abort();

        // A pending promise under `expect().rejects` hangs bun test instead of timing out, so race a timer.
        const outcome = await Promise.race([
            runLiveCapture({
                invocation: { argv: ["sudo", "/usr/bin/eslogger", "exec"], viaSudo: true },
                stream,
                signal: aborted.signal,
                onStderrLine: () => {},
                spawn: () => child,
                stopTimeoutMs: 20,
            }).then(
                () => "returned",
                (error: unknown) => error
            ),
            Bun.sleep(1000).then(() => "still waiting after 1 s"),
        ]);

        expect(outcome).toMatchObject({ message: expect.stringContaining("sudo pkill eslogger") });
        expect(kills).toEqual(["SIGINT", "SIGTERM"]);
        expect(unrefs).toEqual(["unref"]);
        expect(shown.length).toBe(1);
    });

    it("escalates to SIGTERM on Ctrl-C for an eslogger that ignores SIGINT, and returns once it exits", async () => {
        const { child, kills, unrefs } = stubbornProcess({ exitsOn: "SIGTERM" });
        const aborted = new AbortController();
        aborted.abort();

        const result = await runLiveCapture({
            invocation: { argv: ["/usr/bin/eslogger", "exec"], viaSudo: false },
            stream: new EventStream({ filters: [], onEvent: () => {} }),
            signal: aborted.signal,
            onStderrLine: () => {},
            spawn: () => child,
            stopTimeoutMs: 20,
        });

        expect(kills).toEqual(["SIGINT", "SIGTERM"]);
        expect(unrefs).toEqual([]);
        expect(result).toEqual({ exitCode: null, signalCode: "SIGTERM", interrupted: true });
    });
});

describe("tools macos eslogger --dry-run", () => {
    const INDEX = join(import.meta.dir, "../../index.ts");
    let dir: string;
    let home: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "gt-eslogger-dry-"));
        home = mkdtempSync(join(tmpdir(), "gt-eslogger-home-"));
        writeFileSync(join(dir, "recorded.jsonl"), `${EXEC}\n`);
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    });

    async function eslogger(args: string[]) {
        const proc = Bun.spawn({
            cmd: ["bun", "run", INDEX, "eslogger", ...args],
            cwd: dir,
            env: { ...process.env, GENESIS_TOOLS_HOME: home, NO_COLOR: "1" },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        return { stdout, stderr, exitCode };
    }

    it("describes a replay and leaves an existing output file alone", async () => {
        const output = join(dir, "events.log");
        writeFileSync(output, "KEEP-ME\n");

        const { stdout, exitCode } = await eslogger([
            "--dry-run",
            "--input",
            "recorded.jsonl",
            "--output",
            "events.log",
        ]);

        expect(exitCode).toBe(0);
        expect(readFileSync(output, "utf-8")).toBe("KEEP-ME\n");
        expect(stdout).toContain("Would replay: recorded.jsonl");
        expect(stdout).toContain("Output: events.log");
    });

    it("creates no output file for a dry run, nor for a recording that does not exist", async () => {
        const dryRun = await eslogger(["--dry-run", "-e", "exec", "-o", "dry.log"]);
        const missing = await eslogger(["--input", "nope.jsonl", "-o", "missing.log"]);

        expect(dryRun.exitCode).toBe(0);
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr).toContain("No such file: nope.jsonl");
        expect(existsSync(join(dir, "dry.log"))).toBe(false);
        expect(existsSync(join(dir, "missing.log"))).toBe(false);
    });
});
