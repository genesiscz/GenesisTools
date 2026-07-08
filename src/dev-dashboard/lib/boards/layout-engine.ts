// Layout engine — 13 arrange modes + the saved-layout reflow debouncer.
// Task 14 depends only on the `notifyLayoutChanged` hook; Task 15 fills in the engine + debouncer.

/** Trailing-debounced per-board reflow trigger. Stubbed as a no-op for Task 14; Task 15 wires the
 *  real 150ms debounce + reflowBoard. Kept as a stable export so compose/update-cards can call it now. */
export function notifyLayoutChanged(_boardId: number): void {
    // no-op until Task 15 lands the reflow debouncer
}
