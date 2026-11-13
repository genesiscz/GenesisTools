import { afterEach, expect, it, mock } from "bun:test";

mock.module("react-native", () => ({ View: "View", Text: "Text", StyleSheet: { flatten: (value: unknown) => value ?? {} } }));

const { act, cleanup, renderHook } = await import("@testing-library/react-native/pure");
const { useMinuteClock } = await import("@/lib/minute-clock");

afterEach(cleanup);

it("moves on its own while active, with no render from anything else, and stands still while inactive", async () => {
    const active = await renderHook(() => useMinuteClock(true, 30));
    const start = active.result.current;
    await act(async () => {
        await Bun.sleep(120);
    });
    expect(active.result.current).toBeGreaterThan(start);

    const inactive = await renderHook(() => useMinuteClock(false, 30));
    const frozen = inactive.result.current;
    await act(async () => {
        await Bun.sleep(120);
    });
    expect(inactive.result.current).toBe(frozen);
});
