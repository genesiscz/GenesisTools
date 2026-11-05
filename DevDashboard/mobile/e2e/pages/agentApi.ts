import { TEST_AGENT_BASE_URL } from "@e2e/pages/testAgent";

/**
 * Reads the paired test agent's API from the runner (it runs on the Mac, so loopback needs no login). A flow spec
 * compares what the screen shows with what the server answers at the same moment, instead of only checking that a
 * screen rendered.
 */
export async function agentGet<T>(path: string): Promise<T> {
    const response = await fetch(`${TEST_AGENT_BASE_URL}${path}`, { signal: AbortSignal.timeout(20_000) });

    if (!response.ok) {
        throw new Error(`GET ${path} answered ${response.status}`);
    }

    return (await response.json()) as T;
}

/** The accessibility ids on screen that start with `prefix`, with the prefix cut off. */
export async function idsWithPrefix(prefix: string): Promise<string[]> {
    const elements = await $$(`//*[starts-with(@name, "${prefix}") or starts-with(@content-desc, "${prefix}")]`);
    const names: string[] = [];

    for (const element of elements) {
        const name = (await element.getAttribute("name")) ?? (await element.getAttribute("content-desc"));

        if (name?.startsWith(prefix)) {
            names.push(name.slice(prefix.length));
        }
    }

    return [...new Set(names)];
}
