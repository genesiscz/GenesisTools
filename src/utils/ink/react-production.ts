import { env } from "@genesiscz/utils/env";

/**
 * Side-effect only: forces NODE_ENV to "production" before ink/react/react-reconciler are
 * first required, unless something upstream already decided (a developer running
 * NODE_ENV=development, `bun test`'s NODE_ENV=test). Those packages read
 * `process.env.NODE_ENV` once, at require time (`react/index.js`:
 * `require(NODE_ENV === "production" ? "./cjs/react.production.js" : "./cjs/react.development.js")`),
 * and pick the slower, warning-noisy development build when it is unset — which every Ink
 * CLI hit, since none of them ever set NODE_ENV.
 *
 * Import this FIRST, before any other import, in every Ink entry point: static ES imports
 * are hoisted and a file's sibling imports evaluate in source order, each completing before
 * the next starts, so this must be the first import statement in the file to guarantee it
 * runs before anything the file imports — directly or transitively — reaches "ink". See
 * #446 item 4.
 */
env.node.setDefaultEnv("production");
