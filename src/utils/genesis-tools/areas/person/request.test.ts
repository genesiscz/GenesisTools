import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveEngineDeps } from "@genesiscz/utils/genesis-tools/actions/registry";
import { runAction } from "@genesiscz/utils/genesis-tools/actions/run";
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
import { createRequestJournal, type RequestEvent, requestEventSchema, stateOf } from "./journal";
import { requestSchema } from "./request";
import { notifyRequest, presentInApp, presentInSystemDialog, presentInTerminal, type RequestContext } from "./surfaces";

const input = {
    id: "notice:fixture",
    kind: "notice" as const,
    title: "Export complete",
    reason: "Your fixture export is ready.",
};
const now = () => new Date("2026-11-17T12:00:00Z");
const scratch = () => mkdtempSync(join(tmpdir(), "gt-person-"));

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

test("all live effects refuse the test process before a host call", async () => {
    const ctx = {} as RequestContext;
    for (const surface of [presentInApp, presentInSystemDialog, presentInTerminal, notifyRequest]) {
        await expect(surface(ctx)).rejects.toThrow();
    }
    await expect(runVisibly({ argv: ["/usr/bin/true"], timeoutMs: 10 })).rejects.toThrow();
    expect(await connectGenesisToolsService()).toBeNull();
    await expect(startGenesisToolsService()).rejects.toThrow("in-test");
    const result = await runAction(AREAS, "person.notice", input, liveEngineDeps(AREAS));
    expect(result.status).toBe("unreachable");
    expect(result.skipped[0]?.reason).toContain("in-test");
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
    const result = await runAction(AREAS, "person.notice", input, deps, { timeoutMs: 5 });
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
