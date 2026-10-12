import { describe, expect, it, test } from "bun:test";
import { streamTail } from "./run";
import { parseThreadSample } from "./threads";

const REPORT = `Call graph:
    700 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)

Total number in stack (recursive counted multiple, when >=5):

Sort by top of stack, same collapsed (when >= 5):
        __psynch_cvwait  (in libsystem_kernel.dylib)        6185
        __openat_nocancel  (in libsystem_kernel.dylib)        398
        ???  (in bun)  load address 0x100bf0000 + 0x2d8fcdc  [0x10397fcdc]        34
        ???  (in bun)  load address 0x100bf0000 + 0x2d8fcd0  [0x10397fcd0]        25
        stat  (in libsystem_kernel.dylib)        14

Binary Images:
       0x100530000 -        0x1005b50e7 +zsh (113.40.1) <9DBCB17C> /bin/zsh
`;

it("keeps busy frames, drops waits and merges a stripped binary's addresses", () => {
    const summary = parseThreadSample(REPORT);

    expect(summary.waitingSamples).toBe(6185);
    expect(summary.busySamples).toBe(471);
    expect(summary.hotspots).toEqual([
        { symbol: "__openat_nocancel", library: "libsystem_kernel.dylib", samples: 398 },
        { symbol: "(no symbols)", library: "bun", samples: 59 },
        { symbol: "stat", library: "libsystem_kernel.dylib", samples: 14 },
    ]);
});

describe("streamTail", () => {
    test("keeps only the last characters of a long stream, decoding a character split across chunks", async () => {
        const encoder = new TextEncoder();
        const body = `${"x".repeat(5000)}é-end`;
        const bytes = encoder.encode(body);
        const split = bytes.length - 6;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, split));
                controller.enqueue(bytes.slice(split));
                controller.close();
            },
        });

        expect(await streamTail(stream, 10)).toBe(body.slice(-10));
    });
});
