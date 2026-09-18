export type SurfacePrefix = "ax" | "cdp";

export function prefixCandidateId(surface: SurfacePrefix, id: string): string {
    if (id.startsWith("ax:") || id.startsWith("cdp:")) {
        return id;
    }

    return `${surface}:${id}`;
}

export function stripCandidatePrefix(id: string): { surface: SurfacePrefix | null; id: string } {
    if (id.startsWith("ax:")) {
        return { surface: "ax", id: id.slice(3) };
    }

    if (id.startsWith("cdp:")) {
        return { surface: "cdp", id: id.slice(4) };
    }

    return { surface: null, id };
}
