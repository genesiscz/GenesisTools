export { cn } from "@ui/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Deterministic date formatter that produces the same output in Node and the
 * browser. Used in SSR-rendered date labels — `toLocaleDateString` with
 * hour/minute options is not stable across V8 builds (Node's small-icu omits
 * "at"; Chrome inserts it), causing hydration mismatches.
 */
export function formatShortDateTime(input: string | Date): string {
	const d = input instanceof Date ? input : new Date(input);
	const month = MONTHS[d.getMonth()];
	const day = d.getDate();
	const hour24 = d.getHours();
	const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
	const ampm = hour24 < 12 ? "AM" : "PM";
	const minute = String(d.getMinutes()).padStart(2, "0");
	return `${month} ${day} at ${String(hour12).padStart(2, "0")}:${minute} ${ampm}`;
}

/**
 * Long-form date with weekday — same hydration-safety reasoning as
 * `formatShortDateTime`. Output: "Mon, May 4, 03:18 PM".
 */
export function formatLongDateTime(input: string | Date): string {
	const d = input instanceof Date ? input : new Date(input);
	const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const weekday = weekdays[d.getDay()];
	const month = MONTHS[d.getMonth()];
	const day = d.getDate();
	const hour24 = d.getHours();
	const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
	const ampm = hour24 < 12 ? "AM" : "PM";
	const minute = String(d.getMinutes()).padStart(2, "0");
	return `${weekday}, ${month} ${day}, ${String(hour12).padStart(2, "0")}:${minute} ${ampm}`;
}
