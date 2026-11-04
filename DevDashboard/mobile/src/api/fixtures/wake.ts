import type { HealthDto, WakeRelayDto } from "@dd/contract";

// An invented relay for the mock agent and the tests.
export const MOCK_WAKE: WakeRelayDto = {
    configured: true,
    url: "http://relay.example.lan:8787",
    name: "desk-mac",
    password: "fixture-password",
    token: null,
    note: null,
};

export const MOCK_HEALTH: HealthDto = { ok: true, host: "fixture-mac", pid: 4242, startedAt: "2026-10-01T06:00:00.000Z" };
