/**
 * Event System Tests
 *
 * Tests for the generic event broadcasting and subscription system
 */
import { describe, expect, test } from "bun:test";
import { broadcast, broadcastToFeature, broadcastToScope, broadcastToUser, getEventEmitter } from "@/lib/events/server";

describe("Event System", () => {
    test("getEventEmitter returns the same instance", () => {
        const emitter1 = getEventEmitter();
        const emitter2 = getEventEmitter();
        expect(emitter1).toBe(emitter2);
    });

    test("broadcast emits to correct channel", (done) => {
        const emitter = getEventEmitter();
        const channel = "test:channel";
        const testData = { message: "hello" };

        emitter.once(channel, (data) => {
            expect(data).toEqual(testData);
            done();
        });

        broadcast(channel, testData);
    });

    test("broadcastToUser creates correct channel pattern", (done) => {
        const emitter = getEventEmitter();
        const userId = "user123";
        const testData = { type: "sync", timestamp: Date.now() };

        emitter.once(`timer:${userId}`, (data) => {
            expect(data).toEqual(testData);
            done();
        });

        broadcastToUser("timer", userId, testData);
    });

    test("broadcastToScope creates correct channel pattern", (done) => {
        const emitter = getEventEmitter();
        const testData = { type: "message", content: "Hello room" };

        emitter.once("chat:room:room456", (data) => {
            expect(data).toEqual(testData);
            done();
        });

        broadcastToScope("chat", "room", "room456", testData);
    });

    test("broadcastToFeature creates correct channel pattern", (done) => {
        const emitter = getEventEmitter();
        const testData = { type: "announcement", message: "New feature!" };

        emitter.once("timer:*", (data) => {
            expect(data).toEqual(testData);
            done();
        });

        broadcastToFeature("timer", testData);
    });

    test("multiple listeners receive the same event", (done) => {
        const emitter = getEventEmitter();
        const channel = "test:multi";
        const testData = { value: 42 };
        let receivedCount = 0;

        const listener1 = (data: unknown) => {
            expect(data).toEqual(testData);
            receivedCount++;
            if (receivedCount === 2) {
                done();
            }
        };

        const listener2 = (data: unknown) => {
            expect(data).toEqual(testData);
            receivedCount++;
            if (receivedCount === 2) {
                done();
            }
        };

        emitter.once(channel, listener1);
        emitter.once(channel, listener2);

        broadcast(channel, testData);
    });

    test("emitter can handle many concurrent listeners", () => {
        const emitter = getEventEmitter();
        const channel = "test:concurrent";
        const listenerCount = 50;

        let receivedCount = 0;

        for (let i = 0; i < listenerCount; i++) {
            emitter.once(channel, () => {
                receivedCount++;
            });
        }

        broadcast(channel, { test: true });

        // Give it a tick to process
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                expect(receivedCount).toBe(listenerCount);
                resolve();
            }, 100);
        });
    });
});
