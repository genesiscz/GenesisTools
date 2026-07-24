/**
 * Puppeteer arrives transitively through `md-to-pdf`, which `tools reas` uses to
 * render a PDF report. Its postinstall downloads a ~150MB Chromium on every
 * install, and when that cache is incomplete it exits non-zero and FAILS THE
 * WHOLE `bun install`:
 *
 *   Error: The browser folder (~/.cache/puppeteer/chrome-headless-shell/...)
 *   exists but the executable (...) is missing
 *   error: postinstall script from "puppeteer" exited with 1
 *
 * Nothing else in the repo drives a browser through puppeteer, and CI never
 * renders PDFs, so the download is pure cost for everyone except the rare PDF
 * export. Skipping it here keeps installs fast and unbreakable.
 *
 * If you DO need the PDF export and hit "Could not find Chrome", install the
 * browser once, on purpose:
 *
 *   bunx puppeteer browsers install chrome
 *
 * or point at a browser you already have:
 *
 *   export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 */
module.exports = {
    skipDownload: true,
};
