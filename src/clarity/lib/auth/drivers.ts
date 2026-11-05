import { curlAuthDriver } from "@app/clarity/lib/auth/curl-driver";
import { extraAuthDrivers } from "@app/clarity/lib/auth/extra-drivers";
import type { ClarityAuthDriver } from "@app/clarity/lib/auth/types";
import * as clack from "@clack/prompts";

export const DEFAULT_AUTH_DRIVER = curlAuthDriver.id;

export function authDrivers(): ClarityAuthDriver[] {
    return [curlAuthDriver, ...extraAuthDrivers];
}

export function authDriverIds(): string {
    return authDrivers()
        .map((d) => d.id)
        .join("|");
}

/** The driver a saved config names. Undefined when this build does not have it. */
export function savedAuthDriver(id: string | undefined): ClarityAuthDriver | undefined {
    return authDrivers().find((d) => d.id === (id ?? DEFAULT_AUTH_DRIVER));
}

export function findAuthDriver(id: string): ClarityAuthDriver {
    const driver = authDrivers().find((d) => d.id === id);

    if (!driver) {
        throw new Error(`Unknown Clarity auth driver "${id}". Use one of: ${authDriverIds()}.`);
    }

    return driver;
}

/** `--driver` wins; one driver needs no question; otherwise ask, starting at the saved one. Null on cancel. */
export async function chooseAuthDriver(
    flag: string | undefined,
    saved: string | undefined
): Promise<ClarityAuthDriver | null> {
    if (flag) {
        return findAuthDriver(flag);
    }

    const drivers = authDrivers();

    if (drivers.length === 1) {
        return drivers[0];
    }

    const picked = await clack.select({
        message: "How do you want to sign in to Clarity?",
        options: drivers.map((d) => ({ value: d.id, label: d.label })),
        initialValue: savedAuthDriver(saved)?.id ?? DEFAULT_AUTH_DRIVER,
    });

    return clack.isCancel(picked) ? null : findAuthDriver(picked);
}
