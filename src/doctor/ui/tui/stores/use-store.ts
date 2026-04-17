import { createSignal, onCleanup } from "solid-js";
import type { StoreApi } from "zustand/vanilla";

export function useStore<T, U>(store: StoreApi<T>, selector: (state: T) => U): () => U {
    const [value, setValue] = createSignal<U>(selector(store.getState()));
    const unsubscribe = store.subscribe((state) => setValue(() => selector(state)));
    onCleanup(unsubscribe);
    return value;
}
