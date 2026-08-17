/**
 * Browser-safe label constants. `lib/reports/time.ts` exports the same names, but importing
 * that module for a value would drag the whole server report graph into the bundle.
 */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
