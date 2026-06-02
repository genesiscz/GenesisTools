const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");

const projectRoot = __dirname;
// The GenesisTools repo root (two levels up from DevDashboard/mobile).
const workspaceRoot = path.resolve(projectRoot, "../..");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// Watch the repo root so the shared `@devdashboard/contract` source (under
// src/dev-dashboard/contract) is picked up by Metro's file watcher.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(workspaceRoot, "node_modules"),
];

// Mirror the tsconfig `paths` so Metro resolves the same aliases TypeScript does (a
// tsconfig-only alias type-checks but fails the Metro bundle — both must agree). Order
// matters: the most-specific match (`@app/utils/json`) must beat the catch-all `@app/*`.
// Alias map (project convention D30 — no relative imports in app code):
//   @/*   → mobile-internal modules (DevDashboard/mobile/src)
//   @dd/* → shared dev-dashboard code (repo src/dev-dashboard), e.g. @dd/contract
//   @app/utils/json → the RN-safe SafeJSON shim (the contract's one runtime value-import)
//   @app/* → repo src (only the contract's own internal re-exports reach this at runtime;
//            everything else from there is a type-only re-export — see contract-purity.test.ts)
const aliasResolvers = [
    { match: "@app/utils/json", target: path.resolve(projectRoot, "src/shims/safe-json.ts") },
    { prefix: "@dd/", target: path.resolve(workspaceRoot, "src/dev-dashboard") },
    { prefix: "@/", target: path.resolve(projectRoot, "src") },
    { prefix: "@app/", target: path.resolve(workspaceRoot, "src") },
];

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
    for (const rule of aliasResolvers) {
        if (rule.match && moduleName === rule.match) {
            return context.resolveRequest(context, rule.target, platform);
        }

        if (rule.prefix && moduleName.startsWith(rule.prefix)) {
            const rest = moduleName.slice(rule.prefix.length);
            return context.resolveRequest(context, path.join(rule.target, rest), platform);
        }
    }

    if (defaultResolveRequest) {
        return defaultResolveRequest(context, moduleName, platform);
    }

    return context.resolveRequest(context, moduleName, platform);
};

// Hermes lacks the DOM `Event`/`EventTarget`/`CloseEvent` globals that `partysocket` extends at
// module-eval time. expo-router eagerly requires every route module before app code runs, so an
// `index.js` entry import is too late for routes that pull the transport in transitively. The
// serializer's `getPolyfills` runs before ALL user modules — the only hook early enough. See
// src/shims/event-polyfill.ts.
const baseGetPolyfills = config.serializer.getPolyfills;
config.serializer.getPolyfills = (options) => [
    ...baseGetPolyfills(options),
    path.resolve(projectRoot, "src/shims/event-polyfill.ts"),
];

// NativeWind v4: transform `global.css` and inject the className runtime. Applied last so
// it wraps the config that already carries our alias `resolveRequest` + monorepo paths.
module.exports = withNativeWind(config, { input: "./src/global.css" });
