import { expect, mock, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@genesiscz/utils/async";
import { createConfigStore } from "@genesiscz/utils/genesis-tools/actions/config";
import { liveEngineDeps } from "@genesiscz/utils/genesis-tools/actions/registry";
import { runAreaAction } from "@genesiscz/utils/genesis-tools/actions/run";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { LIVE_FACTS } from "@genesiscz/utils/genesis-tools/capability/facts";
import { SafeJSON } from "@genesiscz/utils/json";
import { RpcSocketClient } from "@genesiscz/utils/rpc/socket-client";
import { runVisibly } from "@genesiscz/utils/terminal/visible-run";
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
    requestEventSchema,
    type RequestView,
    requestViewSchema,
    stateOf,
} from "./journal";
import { type PersonRequest, presentPostedRequest, requestSchema } from "./request";
import { notifyRequest, presentInApp, presentInSystemDialog, presentInTerminal, type RequestContext } from "./surfaces";

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
    writeFileSync(join(dir, `${encodeURIComponent(input.id)}.jsonl`), `${SafeJSON.stringify(legacy)}\n`);
    expect(createRequestJournal({ dir }).get(input.id)?.request).toEqual(request);
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
    const file = join(dir, `${encodeURIComponent(input.id)}.jsonl`);
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

test("all live effects refuse the test process before a host call", async () => {
    const ctx = {} as RequestContext;
    for (const surface of [presentInApp, presentInSystemDialog, presentInTerminal, notifyRequest]) {
        await expect(surface(ctx)).rejects.toThrow();
    }
    await expect(runVisibly({ argv: ["/usr/bin/true"], timeoutMs: 10 })).rejects.toThrow();
    expect(await connectGenesisToolsService()).toBeNull();
    await expect(startGenesisToolsService()).rejects.toThrow("in-test");
    const result = await runAreaAction(AREAS, "person.notice", input, liveEngineDeps(AREAS));
    expect(result.status).toBe("unreachable");
    expect(result.skipped[0]?.reason).toContain("in-test");
    const hostCall = mock((): never => {
        throw new Error("The test process reached the host");
    });
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
        deps: { facts: { ...LIVE_FACTS, isTest: () => false, isAgent: () => false, hasDisplay: () => true } },
    });
    if (start.status !== "started") {
        throw new Error("fixture service did not start");
    }
    let presentations = 0;
    const face = await RpcSocketClient.connect({
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
    const client = await connectGenesisToolsService({ dir });
    if (!client) {
        throw new Error("fixture client did not connect");
    }
    try {
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
        await expect(client.call("requests.answer", { id: input.id, status: "declined" })).resolves.toMatchObject({
            status: "done",
        });
        await expect(
            client.call("requests.post", { input: { kind: "root", title: "No", reason: "No" } })
        ).rejects.toThrow();
        await expect(client.call("unknown.method", {})).rejects.toThrow();
        await client.call("config.set", { path: "person.notice.delivery", value: "askNow" });
        expect(await client.call<string>("config.get", { path: "person.notice.delivery" })).toBe("askNow");
        expect(events).toContain("config.changed");
    } finally {
        client.close();
        face.close();
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
        await face.call("requests.answer", { id: serviceId, status: "done" });
        await worker.settle(input.id, "done", null, { via: "notification", method: "click" });
        await withTimeout(settled.promise, 2_000, new Error("worker settlement never reached the face"));

        // Wait for a second scan and drain its notifications before counting duplicates.
        await worker.post({ input: { ...input, id: nextId } });
        await withTimeout(nextPost.promise, 2_000, new Error("next worker post never reached the face"));
        await face.call("unsubscribe");
        const local = changes.filter((view) => view.id === serviceId);
        const external = changes.filter((view) => view.id === input.id);
        expect(local.map((view) => view.state)).toEqual(["waiting", "accepted", "done"]);
        expect(external.map((view) => view.state)).toEqual(["accepted", "done"]);
        expect(local.at(-1)).toEqual(worker.get(serviceId));
        expect(external.at(-1)).toEqual(worker.get(input.id));

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
    expect(rows).toHaveLength(methods.length);
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
    expect(() => renderSwiftSchema({ type: "array", prefixItems: [] }, "Tuple", [], "fixture.tuple")).toThrow(
        "fixture.tuple"
    );
});

test("every byte prefix of a journal has a defined read state without changing bytes", async () => {
    const dir = scratch();
    const journal = createRequestJournal({ dir, now });
    await journal.post({ input });
    await journal.settle(input.id, "done");
    const file = join(dir, `${encodeURIComponent(input.id)}.jsonl`);
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
    const deps = liveEngineDeps(AREAS, {
        facts: { ...LIVE_FACTS, isTest: () => false, isAgent: () => false, hasDisplay: () => true },
        service: {
            journal,
            hasClient: () => true,
            present: async () => {
                shown++;
                return new Promise(() => {});
            },
        },
    });
    const result = await runAreaAction(AREAS, "person.notice", input, deps, { timeoutMs: 5 });
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
