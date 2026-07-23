import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind/NativeWind class strings with conflict resolution (later wins). Lets primitives
 * (e.g. `Card`) carry a base set of classes and accept a caller `className` that appends/overrides
 * layout without the caller having to restate the base surface.
 */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
