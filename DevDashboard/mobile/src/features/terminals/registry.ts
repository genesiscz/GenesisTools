import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type {
    TerminalCallbacks,
    TerminalDriverId,
    TerminalRenderer,
    TerminalSession,
} from "@/features/terminals/TerminalRenderer";

/**
 * Props every driver COMPONENT accepts. A driver is a React component (it owns a mounted `<WebView>`)
 * that exposes the imperative `TerminalRenderer` handle via `forwardRef` + `useImperativeHandle`;
 * the screen renders `<Driver ref={renderRef} session callbacks />` and drives the terminal through
 * the ref. `session` may be null before a session is selected (the component renders an idle shell).
 */
export interface TerminalDriverProps {
    session: TerminalSession | null;
    callbacks: TerminalCallbacks;
}

export type TerminalDriverComponent = ForwardRefExoticComponent<
    TerminalDriverProps & RefAttributes<TerminalRenderer>
>;

export interface DriverMeta {
    id: TerminalDriverId;
    label: string;
    /** One-line description shown in the in-app switcher. */
    blurb: string;
    component: TerminalDriverComponent;
}

/**
 * Driver registry (D12: ship BOTH WebView drivers). `"native"` (the SwiftTerm Expo module) is the
 * reserved escape hatch from `TerminalDriverId` and is intentionally NOT registered in v1 — register
 * it here when the native module exists. Populated by `registerDriver` from the drivers' own modules
 * so this file stays import-cycle-free (the drivers import the types, not the registry).
 */
const DRIVERS = new Map<TerminalDriverId, DriverMeta>();

export function registerDriver(meta: DriverMeta): void {
    DRIVERS.set(meta.id, meta);
}

export function listDrivers(): DriverMeta[] {
    return [...DRIVERS.values()];
}

export function getDriverMeta(id: TerminalDriverId): DriverMeta | undefined {
    return DRIVERS.get(id);
}

/** The driver component for `id`, falling back to the first registered driver if `id` is unknown. */
export function resolveDriver(id: TerminalDriverId): DriverMeta | undefined {
    return DRIVERS.get(id) ?? listDrivers()[0];
}
