export function hasNonEmptySelection(): boolean {
    if (typeof window === "undefined") {
        return false;
    }

    const sel = window.getSelection();

    return sel !== null && sel.toString().trim().length > 0;
}
