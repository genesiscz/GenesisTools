import { describe, expect, it } from "vitest";
import { type DomainEvent, emitDomainEvent, subscribeEvents } from "./event-bus.server";

describe("event-bus.server", () => {
    it("delivers an emitted event to a subscriber for the same user", () => {
        const received: DomainEvent[] = [];
        const unsub = subscribeEvents("user-a", (e) => received.push(e));

        emitDomainEvent("user-a", "timer", { type: "started", timerId: "t1" });

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({ domain: "timer", type: "started", timerId: "t1" });
        unsub();
    });

    it("tags every event with its domain", () => {
        const received: DomainEvent[] = [];
        const unsub = subscribeEvents("user-b", (e) => received.push(e));

        emitDomainEvent("user-b", "notes", { type: "created", noteId: "n1" });
        emitDomainEvent("user-b", "bookmarks", { type: "deleted", bookmarkId: "b9" });

        expect(received.map((e) => e.domain)).toEqual(["notes", "bookmarks"]);
        unsub();
    });

    it("isolates events between users", () => {
        const a: DomainEvent[] = [];
        const b: DomainEvent[] = [];
        const ua = subscribeEvents("user-1", (e) => a.push(e));
        const ub = subscribeEvents("user-2", (e) => b.push(e));

        emitDomainEvent("user-1", "timer", { type: "paused" });

        expect(a).toHaveLength(1);
        expect(b).toHaveLength(0);
        ua();
        ub();
    });

    it("stops delivering after unsubscribe", () => {
        const received: DomainEvent[] = [];
        const unsub = subscribeEvents("user-c", (e) => received.push(e));

        emitDomainEvent("user-c", "ai", { type: "message" });
        unsub();
        emitDomainEvent("user-c", "ai", { type: "message" });

        expect(received).toHaveLength(1);
    });

    it("supports the server-side domain filter pattern used by /api/events", () => {
        const timerOnly: DomainEvent[] = [];
        const wantDomain = "timer";
        const unsub = subscribeEvents("user-d", (e) => {
            if (wantDomain && e.domain !== wantDomain) {
                return;
            }

            timerOnly.push(e);
        });

        emitDomainEvent("user-d", "notes", { type: "created" });
        emitDomainEvent("user-d", "timer", { type: "started" });
        emitDomainEvent("user-d", "bookmarks", { type: "added" });

        expect(timerOnly).toHaveLength(1);
        expect(timerOnly[0].domain).toBe("timer");
        unsub();
    });
});
