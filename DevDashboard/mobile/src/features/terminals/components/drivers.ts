/**
 * Driver barrel. Importing this module triggers BOTH drivers' `registerDriver(...)` side-effects
 * (each driver component self-registers at module load). The Terminal screen imports THIS so
 * `listDrivers()` is non-empty by the time the switcher renders — without a side-effect import the
 * registry would be empty and the switcher would render no options. Keep this the single import
 * point for the driver set.
 */

export { WebViewTtydRenderer } from "@/features/terminals/components/WebViewTtydRenderer";
export { WebViewHtmlRenderer } from "@/features/terminals/components/WebViewHtmlRenderer";
