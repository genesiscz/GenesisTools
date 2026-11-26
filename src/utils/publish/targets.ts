import { isPrivateHost } from "@genesiscz/utils/net/outbound-policy";
import { isSecureRef, type SecureRef } from "@genesiscz/utils/security/SecureRef";
import { z } from "zod";
import { KIND_ID_RE } from "./ids";

export const TARGET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const SSH_HOST_RE = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/;
export const REMOTE_DIR_RE = /^\/[A-Za-z0-9._/-]+$/;
export const ALL_TARGETS = "all";

export type TransportConfig =
    | { kind: "mac-live"; mounts: Record<string, string> }
    | { kind: "paired"; url: string; deviceId: string; token: SecureRef; pairedAt?: string }
    | { kind: "ssh-rsync"; host: string; dataDir: string };

export interface PublishTarget {
    name: string;
    publicBase: string;
    transport: TransportConfig;
}

export type TransportKind = TransportConfig["kind"];
export type TargetWith<K extends TransportKind> = PublishTarget & { transport: Extract<TransportConfig, { kind: K }> };

export function isHttpUrl(url: URL): boolean {
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
}

export function isPrivateOrHttps(url: URL): boolean {
    return isHttpUrl(url) && (url.protocol === "https:" || isPrivateHost(url.hostname));
}

export function isMountPath(path: string): boolean {
    const base = "https://example.com";
    return (
        path.startsWith("/") &&
        !path.startsWith("//") &&
        !path.endsWith("/") &&
        !/[\\?#]/.test(path) &&
        new URL(path, base).pathname === path
    );
}

export function isSshHost(host: string): boolean {
    return SSH_HOST_RE.test(host) && !host.startsWith("-");
}

export function isRemoteDataDir(dir: string): boolean {
    return REMOTE_DIR_RE.test(dir) && !dir.split("/").some((part) => part === "." || part === "..") && /[^/]/.test(dir);
}

const origin = z.string().refine((value) => {
    const url = URL.canParse(value) ? new URL(value) : null;
    return !!url && isHttpUrl(url) && url.origin === value;
}, "expected an HTTP(S) origin");

export const PublishTargetSchema: z.ZodType<PublishTarget> = z
    .object({
        name: z.string().regex(TARGET_NAME_RE),
        publicBase: origin,
        transport: z.discriminatedUnion("kind", [
            z.object({
                kind: z.literal("mac-live"),
                mounts: z.record(z.string().regex(KIND_ID_RE), z.string().refine(isMountPath)),
            }),
            z.object({
                kind: z.literal("paired"),
                url: origin.refine(
                    (value) => URL.canParse(value) && isPrivateOrHttps(new URL(value)),
                    "HTTP requires a private host"
                ),
                deviceId: z.string().min(1),
                pairedAt: z.iso.datetime().optional(),
                token: z.custom<SecureRef>(isSecureRef, { message: "token must be a vault reference" }),
            }),
            z.object({
                kind: z.literal("ssh-rsync"),
                host: z.string().refine(isSshHost, "expected user@host or host"),
                dataDir: z
                    .string()
                    .refine(isRemoteDataDir)
                    .transform((dir) => dir.replace(/\/+$/, "")),
            }),
        ]),
    })
    .refine(
        ({ transport, publicBase }) =>
            transport.kind !== "paired" || (URL.canParse(publicBase) && isPrivateOrHttps(new URL(publicBase))),
        { message: "HTTP requires a private host", path: ["publicBase"] }
    );

export function resolveTargets(input: {
    targets: readonly PublishTarget[];
    defaultTarget?: string;
    names: readonly string[];
}): PublishTarget[] {
    const { targets, defaultTarget, names } = input;
    const selection = names.length ? names : defaultTarget ? [defaultTarget] : [];
    if (selection.includes(ALL_TARGETS)) {
        return [...targets];
    }

    const byName = new Map(targets.map((target) => [target.name, target]));
    return [...new Set(selection)].map((name) => {
        const target = byName.get(name);
        if (!target) {
            throw new Error(`unknown publish target "${name}"`);
        }

        return target;
    });
}
