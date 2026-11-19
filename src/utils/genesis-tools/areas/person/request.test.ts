import { expect, mock, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { createConfigStore } from "@genesiscz/utils/genesis-tools/actions/config";
import { liveEngineDeps } from "@genesiscz/utils/genesis-tools/actions/registry";
import { actionBudgetMs, runAreaAction } from "@genesiscz/utils/genesis-tools/actions/run";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { LIVE_FACTS } from "@genesiscz/utils/genesis-tools/capability/facts";
import { genesisToolsRequestOpenCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { SafeJSON } from "@genesiscz/utils/json";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import {
    removeStaleCommandFiles,
    runVisibly,
    STALE_COMMAND_FILE_MS,
    visibleCommandScript,
} from "@genesiscz/utils/terminal/visible-run";
import {
    renderGenesisToolsRPC,
    renderSwiftSchema,
    SWIFT_PATH,
    WIRE_PATH,
} from "../../../../../scripts/gen-genesis-tools-rpc-swift";
import { genesisToolsApi, requestPresentApi } from "../../service/api";
import { connectGenesisToolsService } from "../../service/clients";
import { startGenesisToolsService } from "../../service/host";
import {
    createRequestJournal,
    type RequestEvent,
    type RequestView,
    requestEventSchema,
    requestFileName,
    requestViewSchema,
    stateOf,
} from "./journal";
import {
    type PersonRequest,
    presentPostedRequest,
    requestSchema,
    requestWindowDeadline,
    WINDOW_REPLY_RESERVE_MS,
} from "./request";
import {
    notifyRequest,
    notifyViaChannels,
    presentInApp,
    presentInSystemDialog,
    presentInTerminal,
    type RequestContext,
} from "./surfaces";
import { type DialogAnswer, type DialogResult, PERSON_DIALOGS } from "./system-dialog";

const input = {
    id: "notice:fixture",
    kind: "notice" as const,
    title: "Export complete",
    reason: "Your fixture export is ready.",
};
const now = () => new Date("2026-11-17T12:00:00Z");
const scratch = () => mkdtempSync(join(tmpdir(), "gt-person-"));
const open = { window: "--meetings" as const, args: ["--meeting", "fixture with spaces"] };

test("a posted event keeps its window target when reopened and an older line still parses", async () => {
    const dir = scratch();
    await createRequestJournal({ dir, now }).post({ input: { ...input, open } });
    const reopened = createRequestJournal({ dir, now });
    expect(reopened.get(input.id)?.request.open).toEqual(open);
    expect(reopened.get(input.id)?.events[0]).toMatchObject({ type: "posted", request: { open } });

    const at = now().toISOString();
    const request = { ...input, createdAt: at };
    const legacy = { type: "posted", at, request, asker: null };
    // An earlier build named the journal after the encoded id; that file is still read.
    const legacyDir = scratch();
    writeFileSync(join(legacyDir, `${encodeURIComponent(input.id)}.jsonl`), `${SafeJSON.stringify(legacy)}\n`);
    expect(createRequestJournal({ dir: legacyDir }).get(input.id)?.request).toEqual(request);
});

test("a window target requires a known face and up to twenty strings of at most 500 characters", () => {
    const request = { ...input, createdAt: now().toISOString() };
    const largest = { window: open.window, args: Array<string>(20).fill("x".repeat(500)) };
    expect(requestSchema.parse({ ...request, open: largest }).open).toEqual(largest);
    for (const target of [
        { ...open, window: "--unknown" },
        { window: open.window },
        { ...open, args: [1] },
        { ...open, args: [...largest.args, ""] },
        { ...open, args: ["x".repeat(501)] },
    ]) {
        expect(requestSchema.safeParse({ ...request, open: target }).success).toBe(false);
    }
});

test("postOnce, append-only recovery, and persisted answers survive a reopen", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir, now });
    const posted = await journal.post({ input });
    expect(await journal.post({ input })).toEqual(posted);
    const file = join(dir, requestFileName(input.id));
    const before = readFileSync(file, "utf8");
    appendFileSync(file, '{"type":');
    const torn = readFileSync(file, "utf8");
    const answer = await journal.settle(input.id, "done");
    expect(readFileSync(file, "utf8").startsWith(torn)).toBe(true);
    expect(torn.startsWith(before)).toBe(true);
    const reopened = createRequestJournal({ dir, now });
    expect(reopened.get(input.id)?.outcome).toEqual(answer);
    expect(await reopened.settle(input.id, "declined")).toEqual(answer);
    expect(await reopened.withdraw(input.id)).toEqual(answer);
    await expect(reopened.settle("missing", "done")).rejects.toThrow("does not exist");
});

test("a change listener that throws fails neither a committed post nor an answer, and the others still hear it", async () => {
    const journal = createRequestJournal({ dir: scratch(), now });
    const heard: string[] = [];
    journal.onChange(() => {
        throw new Error("observer broke");
    });
    journal.onChange((view) => heard.push(view.state));

    const post = await journal.postOnce({ input });
    expect(post.created).toBe(true);
    expect((await journal.settle(input.id, "done")).status).toBe("done");
    expect(heard).toEqual(["waiting", "done"]);
});

test("stateOf defines every prefix, including a dead runner and every terminal state", () => {
    const at = now().toISOString();
    const events: RequestEvent[] = [
        { type: "posted", at, request: { ...input, createdAt: at }, asker: null },
        { type: "delivered", at, channel: "notification", noticeId: input.id },
        { type: "accepted", at, via: "fixture", elevation: null, method: "click" },
        { type: "started", at, runnerPid: 123, where: "background" },
        { type: "finished", at, exitCode: 0, outputTail: "complete", verified: true },
    ];
    expect(events.map((event) => requestEventSchema.parse(event))).toEqual(events);
    const states = [null, "waiting", "waiting", "accepted", "running", "done"] as const;
    for (let length = 0; length <= events.length; length++) {
        expect(stateOf(events.slice(0, length), () => true)?.state ?? null).toBe(states[length]);
    }
    expect(stateOf(events.slice(0, 4), () => false)?.state).toBe("interrupted");
    const endings = [
        { type: "declined", at, via: "fixture", note: "Later" },
        { type: "obsolete", at, reason: "Recovered" },
        { type: "withdrawn", at, reason: "Caller withdrew" },
        { type: "finished", at, exitCode: 1, outputTail: "failed", verified: false },
    ] as const;
    for (const event of endings) {
        const parsed = requestEventSchema.parse(event);
        expect(stateOf([events[0], parsed], () => false)?.state).toBe(
            event.type === "finished" ? "failed" : event.type
        );
    }
});

test("a caller deadline returns pending, leaves the request open, and a later answer wakes a waiter", async () => {
    const journal = createRequestJournal({ dir: scratch() });
    await journal.post({ input });
    expect((await journal.wait(input.id, 1)).status).toBe("pending");
    expect(journal.get(input.id)?.state).toBe("waiting");
    const waiting = journal.wait(input.id, 500);
    await journal.withdraw(input.id);
    expect((await waiting).status).toBe("obsolete");
});

test("windowNotice posts once per caller id and returns after the configured delivery", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir: join(dir, "requests"), now });
    const deliver = () =>
        mock(({ args }: { args: PersonRequest }) => ({ id: args.id, status: "pending" as const, reason: null }));
    const notify = deliver();
    const ask = deliver();
    const actions = AREAS.person.actions;
    const registry = {
        ...AREAS,
        person: {
            ...AREAS.person,
            actions: {
                ...actions,
                notifyThenAsk: { ...actions.notifyThenAsk, native: notify },
                askNow: { ...actions.askNow, native: ask },
            },
        },
    };
    const config = createConfigStore({ registry, file: join(dir, "config.json") });
    const wait = mock(async () => {
        throw new Error("A posted notice must not wait for an answer");
    });
    const deps = liveEngineDeps(registry, {
        config,
        facts: { ...LIVE_FACTS, isTest: () => false, isAgent: () => false },
        service: {
            journal: { ...journal, wait },
            hasClient: () => false,
            present: async () => {
                throw new Error("Only the fake delivery should run");
            },
        },
    });
    const args = { id: input.id, title: input.title, reason: input.reason, open };
    const post = (id: string) => runAreaAction(registry, "person.windowNotice", { ...args, id }, deps);
    expect(config.get("person.windowNotice.delivery")).toBe("notifyThenAsk");
    expect(actions.windowNotice.args.safeParse(input).success).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
        expect(await post(args.id)).toMatchObject({ status: "ran", value: { id: args.id, status: "pending" } });
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(journal.get(args.id)?.request).toMatchObject({ ...args, kind: "notice" });

    await config.set("person.windowNotice.delivery", "askNow");
    expect(await post("notice:second")).toMatchObject({ status: "ran", value: { status: "pending" } });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
});

test("a visible-run script deletes itself first, and a .command file no terminal started goes after an hour", () => {
    const lines = visibleCommandScript(["/bin/echo", "token=x"]).split("\n");
    expect(lines.slice(0, 2)).toEqual(["#!/bin/sh", 'rm -f -- "$0"']);

    const dir = mkdtempSync(join(tmpdir(), "gt-visible-run-"));
    const now = Date.now();
    const old = join(dir, "old.command");
    const fresh = join(dir, "fresh.command");
    const other = join(dir, "old.txt");
    for (const file of [old, fresh, other]) {
        writeFileSync(file, "#!/bin/sh\n");
    }
    const past = (now - STALE_COMMAND_FILE_MS - 60_000) / 1000;
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(removeStaleCommandFiles(dir, now)).toEqual([old]);
    expect([existsSync(old), existsSync(fresh), existsSync(other)]).toEqual([false, true, true]);
});

test("all live effects refuse the test process before a host call", async () => {
    const hostCall = mock((): never => {
        throw new Error("The test process reached the host");
    });
    // A context every surface could run with: only the refusal at the surface's own entry stops it.
    const ctx = {
        args: { ...input, createdAt: now().toISOString(), deadlineSeconds: 1 },
        config: {},
        areaConfig: {},
        timeoutMs: 1_000,
        service: null,
        app: { rpc: hostCall },
        facts: { ...LIVE_FACTS, platform: hostCall, hasDisplay: hostCall },
        pass: (reason: string) => ({ pass: true as const, reason }),
    } as unknown as RequestContext;
    for (const surface of [presentInApp, presentInSystemDialog, presentInTerminal, notifyRequest, notifyViaChannels]) {
        await expect(surface(ctx)).rejects.toThrow("is refused in a test process");
    }
    expect(hostCall).not.toHaveBeenCalled();
    await expect(runVisibly({ argv: ["/usr/bin/true"], timeoutMs: 10 })).rejects.toThrow();
    expect(await connectGenesisToolsService()).toBeNull();
    await expect(startGenesisToolsService()).rejects.toThrow("in-test");
    const result = await runAreaAction(AREAS, "person.notice", input, liveEngineDeps(AREAS));
    expect(result.status).toBe("unreachable");
    expect(result.skipped[0]?.reason).toContain("in-test");
    const deps = liveEngineDeps(AREAS, {
        app: { rpc: hostCall },
        facts: { ...LIVE_FACTS, platform: () => "darwin", appBundle: hostCall, hasDisplay: hostCall },
    });
    const notice = await runAreaAction(AREAS, "person.windowNotice", { ...input, open }, deps);
    expect(notice.status).toBe("unreachable");
    expect(notice.skipped[0]?.reason).toContain("in-test");
    const window = await runAreaAction(AREAS, "windows.open", open, deps);
    expect(window.status).toBe("unreachable");
    expect(window.skipped[0]?.code).toBe("in-test");
    expect(hostCall).not.toHaveBeenCalled();
});

test("a system dialog tells an Approve and a Cancel from a deadline and a failed program", () => {
    const cases: Array<[NodeJS.Platform, DialogResult, DialogAnswer]> = [
        ["darwin", { exitCode: 0, stdout: "button returned:Approve, gave up:false" }, "approved"],
        ["darwin", { exitCode: 1, stdout: "", stderr: "execution error: User canceled. (-128)" }, "cancelled"],
        ["darwin", { exitCode: 0, stdout: "button returned:, gave up:true" }, "gave-up"],
        ["darwin", { exitCode: null, stdout: "" }, "gave-up"],
        ["darwin", { exitCode: 1, stdout: "", stderr: "" }, "failed"],
        ["linux", { exitCode: 0, stdout: "" }, "approved"],
        ["linux", { exitCode: 1, stdout: "" }, "cancelled"],
        ["linux", { exitCode: 5, stdout: "" }, "gave-up"],
        ["linux", { exitCode: null, stdout: "" }, "gave-up"],
        ["linux", { exitCode: 255, stdout: "" }, "failed"],
        ["win32", { exitCode: 0, stdout: "Yes\r\n" }, "approved"],
        ["win32", { exitCode: 0, stdout: "No\r\n" }, "cancelled"],
        ["win32", { exitCode: null, stdout: "" }, "gave-up"],
        ["win32", { exitCode: 1, stdout: "" }, "failed"],
    ];
    expect(cases.map(([platform, result]) => PERSON_DIALOGS[platform]?.answer(result))).toEqual(
        cases.map(([, , answer]) => answer)
    );
});

test("a request window ends before the call that waits for it, so an answer inside its shown deadline arrives", () => {
    // A 10 s request: the window shows 7.5 s, and the 2.5 s left cover the app's start and the reply.
    expect(requestWindowDeadline(10_000, 10)).toEqual({ windowSeconds: 7.5, callTimeoutMs: 10_000 });
    // A short window inside a long budget keeps its seconds; the call waits the reserve longer.
    expect(requestWindowDeadline(120_000, 10)).toEqual({ windowSeconds: 10, callTimeoutMs: 15_000 });
    expect(requestWindowDeadline(120_000, undefined)).toEqual({ windowSeconds: 115, callTimeoutMs: 120_000 });
    expect(requestWindowDeadline(2, undefined)).toEqual({ windowSeconds: 0.002, callTimeoutMs: 2 });
});

test("the request open command ends its options before the id", () => {
    expect(genesisToolsRequestOpenCommand("notice:fixture")).toBe("tools genesis-tools request open -- notice:fixture");
    expect(genesisToolsRequestOpenCommand("--help")).toBe("tools genesis-tools request open -- --help");
    expect(() => genesisToolsRequestOpenCommand("notice fixture")).toThrow("Invalid request id");
});

test("the click worker opens the exact target and records one successful notification click", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir, now });
    const view = await journal.post({ input: { ...input, open } });
    const openWindow = mock(async () => ({ status: "ran" as const, via: "native" as const, value: {}, skipped: [] }));
    const showRequest = mock(async () => {
        throw new Error("An opened target should finish the request");
    });
    const worker = { view, journal, openWindow, showRequest };
    const outcome = await presentPostedRequest(worker);
    const reopened = createRequestJournal({ dir }).get(input.id)!;
    expect(openWindow).toHaveBeenCalledWith(open);
    expect(outcome).toMatchObject({ status: "done", via: "notification", method: "click", exitCode: 0 });
    expect(reopened.outcome).toEqual(outcome);
    expect(reopened.events.map((entry) => entry.type)).toEqual(["posted", "accepted", "finished"]);
    expect(reopened.events[1]).toMatchObject({ type: "accepted", via: "notification", method: "click" });
    expect(reopened.events[2]).toMatchObject({ type: "finished", exitCode: 0 });
    expect(await presentPostedRequest({ ...worker, view: reopened })).toEqual(outcome);
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(showRequest).not.toHaveBeenCalled();
});

test("an unreachable target falls back to the request window and a legacy notice goes straight there", async () => {
    const journal = createRequestJournal({ dir: scratch(), now });
    const openWindow = mock(async () => ({ status: "unreachable" as const, skipped: [], manual: null }));
    const showRequest = mock(async (request: PersonRequest) => ({
        id: request.id,
        status: "pending" as const,
        reason: null,
    }));
    for (const notice of [
        { ...input, open },
        { ...input, id: "notice:legacy" },
    ]) {
        const view = await journal.post({ input: notice });
        const outcome = await presentPostedRequest({ view, journal, openWindow, showRequest });
        expect(openWindow).toHaveBeenCalledTimes(1);
        expect(showRequest).toHaveBeenLastCalledWith(view.request);
        expect(outcome).toEqual({ id: notice.id, status: "pending", reason: null });
        expect(journal.get(notice.id)?.events.map((entry) => entry.type)).toEqual(["posted"]);
    }

    const view = journal.get(input.id)!;
    await presentPostedRequest({ view, journal, showRequest });
    expect(showRequest).toHaveBeenLastCalledWith(view.request);
    expect(showRequest).toHaveBeenCalledTimes(3);

    const withdrawn = await presentPostedRequest({
        view,
        journal,
        openWindow: async () => {
            await journal.withdraw(view.id);
            return { status: "unreachable", skipped: [], manual: null };
        },
        showRequest,
    });
    expect(withdrawn.status).toBe("obsolete");
    expect(showRequest).toHaveBeenCalledTimes(3);
});

test("a notice goes through isolated RPC in both directions, emits events, and reopens settled", async () => {
    const dir = scratch();
    const start = await startGenesisToolsService({
        dir,
        deps: { facts: { ...LIVE_FACTS, isTest: () => false, isAgent: () => false, hasDisplay: async () => true } },
    });
    if (start.status !== "started") {
        throw new Error("fixture service did not start");
    }
    let presentations = 0;
    let face: RpcSocketClient | null = null;
    let client: RpcSocketClient | null = null;
    try {
        face = await RpcSocketClient.connect({
            socket: start.host.entry.socket,
            logScope: "fixture",
            label: "fixture face",
            onRequest: async (incoming) => {
                expect(incoming.method).toBe("request.present");
                const request = requestSchema.parse(incoming.params);
                presentations++;
                return { id: request.id, status: "done", reason: null };
            },
        });
        client = await connectGenesisToolsService({ dir });
        if (!client) {
            throw new Error("fixture client did not connect");
        }
        await face.call("hello", { methods: ["request.present"] });
        const events: string[] = [];
        client.onNotification((event) => events.push(event.method));
        await client.call("subscribe", {});
        const result = await client.call<{ status: string; value: { id: string; status: string } }>(
            "person.notice",
            input
        );
        expect(result.status).toBe("ran");
        expect(result.value.status).toBe("done");
        expect(presentations).toBe(1);
        expect(createRequestJournal({ dir: join(dir, "requests") }).get(input.id)?.outcome.status).toBe("done");
        expect(events.filter((e) => e === "request.changed").length).toBeGreaterThanOrEqual(3);
        await client.call("person.notice", input);
        expect(presentations).toBe(1);
        await expect(client.call("requests.present", { id: input.id })).resolves.toMatchObject({ status: "done" });
        await expect(
            client.call("requests.post", { input: { kind: "root", title: "No", reason: "No" } })
        ).rejects.toThrow();
        await expect(client.call("unknown.method", {})).rejects.toThrow();
        await client.call("config.set", { path: "person.notice.delivery", value: "askNow" });
        expect(await client.call<string>("config.get", { path: "person.notice.delivery" })).toBe("askNow");
        expect(events).toContain("config.changed");
    } finally {
        client?.close();
        face?.close();
        start.host.stop("test complete");
        await start.host.stopped;
    }
});

test("a subscribed face receives each worker and service settlement transition exactly once", async () => {
    const dir = scratch();
    const worker = createRequestJournal({ dir: join(dir, "requests"), now });
    await worker.post({ input });
    const serviceId = "notice:service";
    const nextId = "notice:next";
    const hostCall = mock((): never => {
        throw new Error("A journal change reached the app");
    });
    const start = await startGenesisToolsService({
        dir,
        idleMs: 100,
        checkEveryMs: 200,
        deps: { app: { rpc: hostCall } },
    });
    if (start.status !== "started") {
        throw new Error("fixture service did not start");
    }

    let face: RpcSocketClient | null = null;
    try {
        face = await connectGenesisToolsService({ dir });
        if (!face) {
            throw new Error("fixture face did not connect");
        }

        const changes: RequestView[] = [];
        const settled = Promise.withResolvers<void>();
        const nextPost = Promise.withResolvers<void>();
        face.onNotification((event) => {
            if (event.method !== "request.changed") {
                return;
            }

            const view = requestViewSchema.parse(event.params);
            changes.push(view);

            if (view.id === input.id && view.state === "done") {
                settled.resolve();
            }

            if (view.id === nextId) {
                nextPost.resolve();
            }
        });
        await face.call("subscribe", { events: ["request.changed"] });
        await face.call("requests.post", { input: { ...input, id: serviceId } });
        await face.call("requests.withdraw", { id: serviceId });
        await worker.settle(input.id, "done", null, { via: "notification", method: "click" });
        await withTimeout(settled.promise, 2_000, new Error("worker settlement never reached the face"));

        // Wait for a second scan and drain its notifications before counting duplicates.
        await worker.post({ input: { ...input, id: nextId } });
        await withTimeout(nextPost.promise, 2_000, new Error("next worker post never reached the face"));
        await face.call("unsubscribe");
        const local = changes.filter((view) => view.id === serviceId);
        const external = changes.filter((view) => view.id === input.id);
        expect(local.map((view) => view.state)).toEqual(["waiting", "withdrawn"]);
        expect(external.map((view) => view.state)).toEqual(["accepted", "done"]);
        expect(local.at(-1)).toEqual(worker.get(serviceId) ?? undefined);
        expect(external.at(-1)).toEqual(worker.get(input.id) ?? undefined);

        await worker.withdraw(nextId);
        face.close();
        face = null;
        const stopped = await withTimeout(start.host.stopped, 2_000, new Error("journal watcher prevented idle exit"));
        expect(stopped).toBe("idle");
        expect(hostCall).not.toHaveBeenCalled();
    } finally {
        face?.close();
        start.host.stop("test complete");
        await start.host.stopped;
    }
});

test("every generated fixture parses in TypeScript and generated files are current", () => {
    const rows: unknown = SafeJSON.parse(readFileSync(WIRE_PATH, "utf8"));
    if (!Array.isArray(rows)) {
        throw new Error("Wire fixtures must be an array");
    }
    const methods = [...genesisToolsApi.methods, ...requestPresentApi.methods];
    expect(
        new Set(rows.map((row) => (typeof row === "object" && row !== null && "method" in row ? row.method : null)))
    ).toEqual(new Set(methods.map((m) => m.name)));
    // The second arm of an action reply and the null of a nullable field reach the Swift decoders too.
    const replies = rows.map((row) => SafeJSON.stringify(typeof row === "object" && row !== null ? row : {}));
    expect(replies.some((row) => row.includes('"status":"unreachable"') && row.includes('"manual":null'))).toBe(true);
    expect(replies.some((row) => row.includes('"fix":null'))).toBe(true);
    for (const row of rows) {
        if (typeof row !== "object" || row === null || !("method" in row) || !("params" in row) || !("result" in row)) {
            throw new Error("Invalid fixture row");
        }
        const method = methods.find((m) => m.name === row.method);
        if (!method) {
            throw new Error("Unknown fixture method");
        }
        expect(method.params.safeParse(row.params).success).toBe(true);
        expect(method.result.safeParse(row.result).success).toBe(true);
    }
    const generated = renderGenesisToolsRPC();
    expect(readFileSync(SWIFT_PATH, "utf8")).toBe(generated.swift);
    expect(readFileSync(WIRE_PATH, "utf8")).toBe(generated.fixtures);
    expect(() => renderSwiftSchema({ type: "unsupported" }, "Unsupported", [], "fixture.unsupported")).toThrow(
        "fixture.unsupported"
    );
    expect(() => renderSwiftSchema({ not: {} }, "Never", [], "fixture.never")).toThrow("fixture.never");
    const unionDeclarations: string[] = [];
    renderSwiftSchema(
        { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] },
        "Mixed",
        unionDeclarations,
        "fixture.mixed"
    );
    expect(unionDeclarations.join("\n")).toContain("case option2(GenesisToolsNull)");
    expect(() => renderSwiftSchema({ type: "array", prefixItems: [] }, "Tuple", [], "fixture.tuple")).toThrow(
        "fixture.tuple"
    );
});

test("every byte prefix of a journal has a defined read state without changing bytes", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir, now });
    await journal.post({ input });
    await journal.settle(input.id, "done");
    const file = join(dir, requestFileName(input.id));
    const full = readFileSync(file, "utf8");
    for (let length = 0; length <= full.length; length++) {
        const prefix = full.slice(0, length);
        writeFileSync(file, prefix);
        const view = createRequestJournal({ dir, now }).get(input.id);
        expect(view === null || ["waiting", "accepted", "done"].includes(view.state)).toBe(true);
        expect(readFileSync(file, "utf8")).toBe(prefix);
    }
});

test("a timed-out request action returns pending and keeps its posted request open", async () => {
    const journal = createRequestJournal({ dir: scratch() });
    let shown = 0;
    const presented = Promise.withResolvers<void>();
    const deps = liveEngineDeps(AREAS, {
        facts: { ...LIVE_FACTS, isTest: () => false, isAgent: () => false, hasDisplay: async () => true },
        service: {
            journal,
            hasClient: () => true,
            present: async () => {
                shown++;
                presented.resolve();
                return new Promise(() => {});
            },
        },
    });
    // The presentation starts inside the deadline and never answers; the nested delivery shares the action's deadline.
    const result = await runAreaAction(AREAS, "person.notice", input, deps, { timeoutMs: 1_000 });
    await withTimeout(presented.promise, 2_000, new Error("the request was never presented"));
    expect(
        result.status === "ran" &&
            typeof result.value === "object" &&
            result.value !== null &&
            "status" in result.value &&
            result.value.status
    ).toBe("pending");
    expect(journal.get(input.id)?.state).toBe("waiting");
    expect(shown).toBe(1);
});

test("request identity cannot cross journal files, and posted metadata is structured", async () => {
    const journal = createRequestJournal({ dir: scratch(), now });
    const posted = await journal.post({ input });
    expect(() =>
        journal.append("another", {
            type: "posted",
            at: now().toISOString(),
            request: posted.request,
            asker: { agent: "fixture", session: "fixture" },
        })
    ).toThrow("different request id");
    expect(
        requestEventSchema.safeParse({
            type: "posted",
            at: now().toISOString(),
            request: posted.request,
            asker: { agent: "fixture" },
        }).success
    ).toBe(true);
    expect(
        requestEventSchema.safeParse({
            type: "posted",
            at: now().toISOString(),
            request: posted.request,
            asker: "unstructured",
        }).success
    ).toBe(false);
});

test("the service stays for an open request and exits on the idle check once it is withdrawn", async () => {
    const dir = scratch();
    const start = await startGenesisToolsService({ dir, idleMs: 1, checkEveryMs: 100 });
    if (start.status !== "started") {
        throw new Error("fixture service did not start");
    }
    let stopped = false;
    void start.host.stopped.then(() => {
        stopped = true;
    });
    const journal = start.deps.service!.journal;
    await journal.post({ input });
    try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(stopped).toBe(false);
        await journal.withdraw(input.id);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("idle exit did not arrive")), 1500);
            });
            expect(await Promise.race([start.host.stopped, deadline])).toBe("idle");
        } finally {
            clearTimeout(timer);
        }
    } finally {
        start.host.stop("test complete");
    }
});

test("every valid id gets a short file name, and ids that differ only in case stay apart", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir, now });
    const long = `notice:${"x".repeat(493)}`;
    expect(long.length).toBe(500);
    expect((await journal.post({ input: { ...input, id: long } })).id).toBe(long);
    expect(Buffer.byteLength(requestFileName(long))).toBeLessThan(255);
    await journal.post({ input: { ...input, id: "notice:Build" } });
    await journal.post({ input: { ...input, id: "notice:build", title: "Lower case" } });
    expect(journal.get("notice:Build")?.request.title).toBe(input.title);
    expect(journal.get("notice:build")?.request.title).toBe("Lower case");
    expect(
        journal
            .list()
            .map((view) => view.id)
            .sort()
    ).toEqual(["notice:Build", "notice:build", long].sort());
});

test("racing posts create one request, and racing answers and a withdrawal record one terminal event", async () => {
    const dir = scratch();
    const service = createRequestJournal({ dir, now });
    const worker = createRequestJournal({ dir, now });
    const posts = await Promise.all([service.postOnce({ input }), worker.postOnce({ input })]);
    expect(posts.filter((post) => post.created)).toHaveLength(1);
    expect(service.get(input.id)?.events.map((event) => event.type)).toEqual(["posted"]);

    const answers = await Promise.all([
        service.settle(input.id, "done", null, { via: "app-window" }),
        worker.settle(input.id, "done", null, { via: "notification" }),
        worker.withdraw(input.id),
    ]);
    const events = service.get(input.id)!.events.map((event) => event.type);
    expect(events.filter((type) => type === "accepted").length).toBeLessThanOrEqual(1);
    expect(events.filter((type) => ["finished", "withdrawn"].includes(type))).toHaveLength(1);
    expect(new Set(answers.map((answer) => SafeJSON.stringify(answer))).size).toBe(1);
});

test("an answer whose finish was lost completes it without a second acceptance", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir, now });
    await journal.post({ input });
    journal.append(input.id, {
        type: "accepted",
        at: now().toISOString(),
        via: "app-window",
        elevation: null,
        method: "click",
    });
    expect((await journal.settle(input.id, "done")).status).toBe("done");
    expect(journal.get(input.id)?.events.map((event) => event.type)).toEqual(["posted", "accepted", "finished"]);
});

test("a wait rejects when the journal cannot be read at its deadline", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir, now });
    await journal.post({ input });
    const waiting = journal.wait(input.id, 50);
    appendFileSync(join(dir, requestFileName(input.id)), '{"type":"unknown"}\n');
    await expect(waiting).rejects.toThrow();
});

test("a journal that cannot be read leaves only itself out of the list", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir, now });
    await journal.post({ input });
    await journal.post({ input: { ...input, id: "notice:damaged" } });
    appendFileSync(join(dir, requestFileName("notice:damaged")), '{"type":"unknown"}\n');
    expect(journal.list().map((view) => view.id)).toEqual([input.id]);
    expect(journal.pending().map((view) => view.id)).toEqual([input.id]);
    expect(() => journal.get("notice:damaged")).toThrow();
});

test("the list returns the newest requests by post time and reads a settled journal once", async () => {
    const dir = scratch();
    let minute = 0;
    const journal = createRequestJournal({ dir, now: () => new Date(Date.UTC(2026, 10, 17, 12, minute++)) });
    for (const id of ["notice:c", "notice:a", "notice:b"]) {
        await journal.post({ input: { ...input, id } });
    }

    expect(journal.list({ limit: 2 }).map((view) => view.id)).toEqual(["notice:a", "notice:b"]);
    await journal.settle("notice:c", "done");
    expect(journal.pending().map((view) => view.id)).toEqual(["notice:a", "notice:b"]);
    const settledView = journal.list().find((view) => view.id === "notice:c");
    expect(settledView?.state).toBe("done");
    // A settled journal is not read again: a damaged copy on disk does not change the listed view.
    appendFileSync(join(dir, requestFileName("notice:c")), '{"type":"unknown"}\n');
    expect(journal.list().find((view) => view.id === "notice:c")).toEqual(settledView);
});

test("one worker at a time presents a waiting request, and a settled request is not presented", async () => {
    const journal = createRequestJournal({ dir: scratch(), now });
    await journal.post({ input });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const first = journal.claim(input.id, async () => {
        entered.resolve();
        await release.promise;
        return "first";
    });
    await entered.promise;
    const second = await journal.claim(input.id, async () => "second");
    expect(second).toMatchObject({ claimed: false, view: { state: "waiting" } });
    release.resolve();
    expect(await first).toEqual({ claimed: true, value: "first" });

    await journal.withdraw(input.id);
    expect(await journal.claim(input.id, async () => "late")).toMatchObject({
        claimed: false,
        view: { state: "withdrawn" },
    });
});

test("a client cannot hand in a person's answer; the service records what its own presentation returned", async () => {
    const dir = scratch();
    const start = await startGenesisToolsService({
        dir,
        deps: { facts: { ...LIVE_FACTS, isTest: () => false, isAgent: () => false, hasDisplay: async () => true } },
    });
    if (start.status !== "started") {
        throw new Error("fixture service did not start");
    }

    const shown: PersonRequest[] = [];
    const face = await RpcSocketClient.connect({
        socket: start.host.entry.socket,
        logScope: "fixture",
        label: "fixture face",
        onRequest: async (incoming) => {
            const request = requestSchema.parse(incoming.params);
            shown.push(request);
            return { id: request.id, status: "declined", reason: null };
        },
    });
    const client = await connectGenesisToolsService({ dir });
    if (!client) {
        throw new Error("fixture client did not connect");
    }

    try {
        await face.call("hello", { methods: ["request.present"] });
        await client.call("requests.post", { input });
        await expect(client.call("requests.answer", { id: input.id, status: "done" })).rejects.toThrow();
        expect(createRequestJournal({ dir: join(dir, "requests") }).get(input.id)?.state).toBe("waiting");

        await expect(client.call("requests.present", { id: input.id })).resolves.toMatchObject({
            status: "declined",
            via: "app-window",
        });
        expect(shown.map((request) => request.takesFocus)).toEqual([true]);
        // The face's window ends a reply reserve before the service stops waiting for it.
        expect((shown[0]?.deadlineSeconds ?? Number.POSITIVE_INFINITY) * 1000).toBeLessThanOrEqual(
            actionBudgetMs(AREAS.person.actions.showWindow) - WINDOW_REPLY_RESERVE_MS
        );
        expect(await client.call("requests.present", { id: input.id })).toMatchObject({ status: "declined" });
        expect(shown).toHaveLength(1);

        // An automatic presentation follows the focus setting; a click on the notification asks for focus.
        await client.call("config.set", { path: "person.dialog", value: { takesFocus: false } });
        for (const id of ["notice:quiet", "notice:clicked"]) {
            await client.call("requests.post", { input: { ...input, id } });
        }

        await client.call("requests.present", { id: "notice:quiet" });
        await client.call("requests.present", { id: "notice:clicked", takesFocus: true });
        expect(shown.slice(1).map((request) => [request.id, request.takesFocus])).toEqual([
            ["notice:quiet", false],
            ["notice:clicked", true],
        ]);
    } finally {
        client.close();
        face.close();
        start.host.stop("test complete");
        await start.host.stopped;
    }
});

test("a call over the service socket never prompts in the service's own terminal", async () => {
    const dir = scratch();
    const start = await startGenesisToolsService({
        dir,
        deps: {
            facts: {
                ...LIVE_FACTS,
                isTest: () => false,
                isAgent: () => false,
                hasDisplay: async () => false,
                hasTerminal: () => true,
            },
        },
    });
    if (start.status !== "started") {
        throw new Error("fixture service did not start");
    }

    const client = await connectGenesisToolsService({ dir });
    if (!client) {
        throw new Error("fixture client did not connect");
    }

    try {
        const request = { ...input, createdAt: now().toISOString() };
        for (const id of ["terminal.prompt", "person.showWindow"]) {
            const outcome = await client.call<{ status: string; skipped: Array<{ code: string }> }>(id, request);
            expect(outcome.status).toBe("unreachable");
            expect(outcome.skipped.map((skip) => skip.code)).toContain("no-terminal");
        }
    } finally {
        client.close();
        start.host.stop("test complete");
        await start.host.stopped;
    }
});

test("two click workers for one request open its target once", async () => {
    const journal = createRequestJournal({ dir: scratch(), now });
    const view = await journal.post({ input: { ...input, open } });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const openWindow = mock(async () => {
        entered.resolve();
        await release.promise;
        return { status: "ran" as const, via: "native" as const, value: {}, skipped: [] };
    });
    const showRequest = mock(async (request: PersonRequest) => ({
        id: request.id,
        status: "pending" as const,
        reason: null,
    }));
    const first = presentPostedRequest({ view, journal, openWindow, showRequest });
    await entered.promise;
    expect(await presentPostedRequest({ view, journal, openWindow, showRequest })).toMatchObject({
        status: "pending",
        reason: "Another worker is presenting this request.",
    });
    release.resolve();
    expect(await first).toMatchObject({ status: "done" });
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(showRequest).not.toHaveBeenCalled();
});

test("a request no surface took is delivered again on a retry, and its delivery names the surface that took it", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir: join(dir, "requests"), now });
    let askCalls = 0;
    const ask = mock(({ args }: { args: PersonRequest }) => {
        askCalls++;
        return askCalls === 1
            ? { pass: true as const, reason: "No display yet." }
            : { id: args.id, status: "pending" as const, reason: null };
    });
    const notify = mock(({ args }: { args: PersonRequest }) => ({
        id: args.id,
        status: "pending" as const,
        reason: null,
    }));
    const actions = AREAS.person.actions;
    const registry = {
        ...AREAS,
        person: {
            ...AREAS.person,
            actions: {
                ...actions,
                askNow: { ...actions.askNow, native: ask },
                notifyThenAsk: { ...actions.notifyThenAsk, native: notify },
                askElseNotify: {
                    ...actions.askElseNotify,
                    native: () => ({ pass: true as const, reason: "Every window way failed." }),
                },
            },
        },
    };
    const config = createConfigStore({ registry, file: join(dir, "config.json") });
    const wait = mock(async (id: string) => ({ id, status: "pending" as const, reason: "waited" }));
    const deps = liveEngineDeps(registry, {
        config,
        facts: { ...LIVE_FACTS, isTest: () => false, isAgent: () => false, hasDisplay: async () => true },
        service: {
            journal: { ...journal, wait },
            hasClient: () => false,
            present: async () => {
                throw new Error("Only the fake delivery should run");
            },
        },
    });
    const run = (id: string) => runAreaAction(registry, "person.ask", { ...input, id }, deps);

    expect(await run(input.id)).toMatchObject({ status: "ran", value: { status: "unreachable" } });
    expect(journal.get(input.id)?.events.map((event) => event.type)).toEqual(["posted"]);
    expect(await run(input.id)).toMatchObject({ status: "ran", value: { reason: "waited" } });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(journal.get(input.id)?.events.at(-1)).toMatchObject({ type: "delivered", channel: "dialog" });
    await run(input.id);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);

    // A display is there, but every window way fails and the notification fallback takes the request.
    await config.set("person.ask.delivery", "askElseNotify");
    await run("notice:fallback");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(journal.get("notice:fallback")?.events.at(-1)).toMatchObject({
        type: "delivered",
        channel: "notification",
    });
});
