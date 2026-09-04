import { useCallback, useMemo } from "react";
import { moveItem, reconcileOrder } from "@/lib/block-layout";
import { NAV_ROUTES, type NavRoute } from "@/lib/nav-routes";
import { parseStringArray, usePersistedState } from "@/lib/persisted-state";

export const NAV_ORDER_KEY = "dd:nav-order";

const DEFAULT_ORDER = NAV_ROUTES.map((r) => r.to);

/**
 * The sidebar order the user chose. Unknown ids are dropped and routes added
 * later are appended, so a stored order never hides a new feature.
 */
export function useNavOrder(): {
    routes: NavRoute[];
    move: (from: number, to: number) => void;
    moveBy: (to: string, direction: -1 | 1) => void;
    reset: () => void;
    isCustom: boolean;
} {
    const [stored, setStored, reset] = usePersistedState<string[]>(NAV_ORDER_KEY, parseStringArray, DEFAULT_ORDER);
    const order = useMemo(() => reconcileOrder(stored, DEFAULT_ORDER), [stored]);
    const routes = useMemo(() => {
        const byPath = new Map(NAV_ROUTES.map((r) => [r.to, r] as const));
        return order.map((to) => byPath.get(to)).filter((r): r is NavRoute => r !== undefined);
    }, [order]);

    const move = useCallback((from: number, to: number) => setStored(moveItem(order, from, to)), [order, setStored]);
    const moveBy = useCallback(
        (to: string, direction: -1 | 1) => {
            const from = order.indexOf(to);

            if (from === -1) {
                return;
            }

            setStored(moveItem(order, from, from + direction));
        },
        [order, setStored]
    );

    const isCustom = useMemo(() => order.some((to, i) => to !== DEFAULT_ORDER[i]), [order]);

    return { routes, move, moveBy, reset, isCustom };
}
