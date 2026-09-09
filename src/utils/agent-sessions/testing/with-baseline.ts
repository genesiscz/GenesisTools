import { test } from "bun:test";
import { baselineRevisionAvailable } from "./baseline-oracle";

/**
 * Declares a test that compares against the frozen baseline oracle.
 *
 * Two things every such test needs, in one place: it is skipped when this clone lacks the
 * pinned revision (CI checks out shallow), and it never inherits bun's 5 s default, because
 * materializing that revision and starting its driver costs seconds on its own.
 */
export const withBaseline = (label: string, body: () => Promise<void>, timeout = 120_000) =>
    test.skipIf(!baselineRevisionAvailable())(label, body, timeout);
