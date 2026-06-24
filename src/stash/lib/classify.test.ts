import { describe, expect, test } from "bun:test";
import { type ClassifyInput, classifyRegion } from "./classify";

const baseStored = "logger.debug('x');";

describe("classifyRegion", () => {
    test("unchanged when stored == current", () => {
        const input: ClassifyInput = { storedContent: baseStored, currentContent: baseStored, present: true };
        expect(classifyRegion(input).klass).toBe("unchanged");
    });
    test("edited when stored != current and both present", () => {
        const input: ClassifyInput = { storedContent: baseStored, currentContent: "logger.debug('y');", present: true };
        expect(classifyRegion(input).klass).toBe("edited");
    });
    test("missing when markers absent", () => {
        const input: ClassifyInput = { storedContent: baseStored, currentContent: null, present: false };
        expect(classifyRegion(input).klass).toBe("missing");
    });
    test("ignores trailing whitespace differences", () => {
        const input: ClassifyInput = { storedContent: baseStored, currentContent: `${baseStored}   `, present: true };
        expect(classifyRegion(input).klass).toBe("unchanged");
    });
});
