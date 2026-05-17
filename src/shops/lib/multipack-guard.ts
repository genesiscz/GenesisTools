export function compatPackCount(a: number | null, b: number | null): boolean {
    if (a === null && b === null) {
        return true;
    }

    if (a === null) {
        return b === 1;
    }

    if (b === null) {
        return a === 1;
    }

    return a === b;
}
