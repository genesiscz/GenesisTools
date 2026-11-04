/**
 * Wake my Mac (F26). Types only (`contract-purity.test.ts`). A sleeping Mac answers nothing, so the phone keeps the
 * wakeup relay's address and login (`/api/gateway/wake`, read while the Mac is awake) and posts the relay's `/wake`
 * itself; `/api/health` then tells it the Mac is back.
 */

export interface WakeRelayDto {
    /** False until `tools wakeup login` saved a relay and a registered device on this Mac. */
    configured: boolean;
    /** `http://host:port` of the relay, which must run on an always-on machine on the Mac's LAN. */
    url: string | null;
    /** The device name the relay registered this Mac under, and its relay password. */
    name: string | null;
    password: string | null;
    /** The relay's bearer token, when it has one. */
    token: string | null;
    /** Why the relay cannot wake this Mac (not configured, or it runs on this Mac itself). */
    note: string | null;
}

export interface HealthDto {
    ok: true;
    host: string;
    pid: number;
    startedAt: string;
}
