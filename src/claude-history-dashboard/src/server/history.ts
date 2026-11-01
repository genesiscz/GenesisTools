/**
 * The history library, loaded on the first call and not when the importing module loads.
 *
 * `search.ts` reaches the provider registry, which imports every AI provider plugin: about 380 modules that
 * Vite's dev server transforms and runs. The server functions and the API routes load with the route tree on
 * every request, so a static import made the first `GET /` pay for all of them (40 to 90 s on a loaded
 * machine). A handler body runs only when a page asks for data.
 */
export const history = () => import("@app/claude/lib/history/search");
