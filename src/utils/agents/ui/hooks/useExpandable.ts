import { useCallback, useState } from "react";

export function useExpandable(defaultExpanded = false) {
    const [expanded, setExpanded] = useState(defaultExpanded);

    const toggle = useCallback(() => {
        setExpanded((prev) => !prev);
    }, []);

    return { expanded, toggle } as const;
}
