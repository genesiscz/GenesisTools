import { registerWorkDoor } from "@genesiscz/utils/work/door";

/** The tool fills the work area's seam; importing the actions package never loads the work tool until a call. */
export function registerCliWorkDoor(): void {
    registerWorkDoor({
        call: async (method, params, options) => {
            // lint-rules-ignore: the actions tool fills the work area's registered seam (spec P7); a lazy import keeps the work tool out of every other action's start
            const { callWorkHere } = await import("@app/work/doors/service");
            return callWorkHere(method, params, options);
        },
    });
}
