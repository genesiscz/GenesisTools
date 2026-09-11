import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Ownership and uniqueness guarantees of the store, against a real in-memory SQLite with the
 * generated migrations applied — the two properties a mocked store cannot prove: that a device
 * belonging to another account is untouchable, and that the account_id index makes a duplicate
 * subscription impossible however the race lands.
 */

// Force an in-memory SQLite DB BEFORE importing anything that reads env.
process.env.DD_CLOUD_DATABASE_URL = ":memory:";
process.env.DD_CLOUD_DATABASE_DRIVER = "sqlite";

type Store = typeof import("./cloud-store").cloudStore;

let cloudStore: Store;

async function seedUser(id: string): Promise<void> {
    const { db } = await import("./index");
    const { user } = await import("./schema");
    const now = new Date();
    await db.insert(user).values({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
    });
}

beforeAll(async () => {
    // The store's own runner, not a hand-applied copy: it records the applied ids, so the migration
    // every store call triggers is the same one the app runs at boot.
    const { ensureMigrated } = await import("./migrate");
    ensureMigrated();

    ({ cloudStore } = await import("./cloud-store"));
    await seedUser("owner");
    await seedUser("intruder");
});

afterAll(async () => {
    const { sqlite } = await import("./index");
    sqlite.close();
});

describe("cloudStore.removeDevice — cross-account ownership", () => {
    it("leaves a device belonging to another account in place", async () => {
        const device = await cloudStore.addDevice({
            accountId: "owner",
            label: "Studio Mac",
            kind: "agent",
            publicKey: "AAAA1111BBBB2222",
        });

        await cloudStore.removeDevice("intruder", device.id);

        const stillThere = await cloudStore.listDevices("owner");
        expect(stillThere.map((d) => d.id)).toContain(device.id);
        expect(await cloudStore.listDevices("intruder")).toEqual([]);
    });

    it("removes the device for its real owner", async () => {
        const device = await cloudStore.addDevice({
            accountId: "owner",
            label: "Phone",
            kind: "phone",
            publicKey: "CCCC3333DDDD4444",
        });

        await cloudStore.removeDevice("owner", device.id);

        const remaining = await cloudStore.listDevices("owner");
        expect(remaining.map((d) => d.id)).not.toContain(device.id);
    });
});

describe("cloudStore.ensureSubscription — one row per account", () => {
    it("returns the same row on a repeat call instead of inserting a second", async () => {
        const first = await cloudStore.ensureSubscription("owner");
        const second = await cloudStore.ensureSubscription("owner");

        expect(second.id).toBe(first.id);
    });

    it("survives concurrent first calls without duplicating the row", async () => {
        await seedUser("racer");

        const [a, b, c] = await Promise.all([
            cloudStore.ensureSubscription("racer"),
            cloudStore.ensureSubscription("racer"),
            cloudStore.ensureSubscription("racer"),
        ]);

        const stored = await cloudStore.getSubscription("racer");
        expect(stored).not.toBeNull();
        // Whichever insert won, every caller ends up naming the row that is actually stored.
        expect(new Set([a.id, b.id, c.id]).has(stored?.id ?? "")).toBe(true);
        expect(a.id).toBe(b.id);
        expect(b.id).toBe(c.id);
    });
});
