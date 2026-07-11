/**
 * Cross-hook input scope: while a modal (e.g. the Sessions action menu) is
 * open, global key handlers (tab navigation digits/arrows) must not react to
 * the same keystrokes. Ink has no built-in input scoping; this module-level
 * flag is the minimal shared channel between sibling hooks.
 */
let modalCount = 0;

export function setModalOpen(open: boolean): void {
    modalCount = Math.max(0, modalCount + (open ? 1 : -1));
}

export function isModalOpen(): boolean {
    return modalCount > 0;
}
