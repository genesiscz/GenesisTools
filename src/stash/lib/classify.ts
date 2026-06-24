export type RegionClass = "unchanged" | "edited" | "missing" | "new-extra";

export interface ClassifyInput {
    storedContent: string;
    currentContent: string | null;
    present: boolean;
}

export interface Classification {
    klass: RegionClass;
}

export function classifyRegion(input: ClassifyInput): Classification {
    if (!input.present) {
        return { klass: "missing" };
    }
    if (input.currentContent === null) {
        return { klass: "missing" };
    }
    const norm = (s: string) =>
        s
            .split("\n")
            .map((l) => l.trimEnd())
            .join("\n")
            .replace(/\n+$/, "");
    if (norm(input.storedContent) === norm(input.currentContent)) {
        return { klass: "unchanged" };
    }
    return { klass: "edited" };
}
