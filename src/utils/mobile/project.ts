import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { SIMCTL_PRIVACY_SERVICES, type SimctlPrivacyService } from "./simulator";

const log = logger.child({ component: "mobile.project" });

/**
 * The project file `tools mobile` reads: which app it drives, how to build it, and which screens it has. The tool
 * knows no app by itself; a project describes its own app in a `mobile.config.ts` that default-exports a
 * `MobileProjectConfig`. Paths in it are relative to the file.
 *
 * ```ts
 * import type { MobileProjectConfig } from "@genesiscz/utils/mobile/project";
 *
 * export default {
 *     id: "shop",
 *     platforms: {
 *         ios: {
 *             bundleId: "com.example.shop",
 *             build: { workspace: "ios/Shop.xcworkspace", scheme: "Shop", configuration: "Release", productName: "Shop" },
 *         },
 *     },
 *     routes: [{ name: "home", url: "shop:///", rootId: "screen-home" }],
 * } satisfies MobileProjectConfig;
 * ```
 */
export interface MobileProjectConfig {
    /** A file-safe id; build logs, install records and run folders carry it. */
    id: string;
    title?: string;
    /** The app folder (the one holding `ios/`), relative to the config file; default: the config file's folder. */
    appDir?: string;
    /** Every screen in the order a user meets them, or a function that reads them from the app's folder. */
    routes?: MobileRoute[] | ((appDir: string) => MobileRoute[]);
    /** A React Native app whose Debug build loads its JavaScript from Metro (`bunx expo start`); absent without Metro. */
    metro?: MetroSetup;
    /** One entry per platform the app ships on; a command for a platform the project does not name refuses. */
    platforms: MobilePlatformsConfig;
}

export interface MetroSetup {
    /** The port `up` starts Metro on when `--metro-port` is not given. */
    defaultPort: number;
}

export interface MobilePlatformsConfig {
    ios?: IosAppConfig;
}

/** One screen of an app, reached by a deep link. */
export interface MobileRoute {
    /** A file-safe name, used in screenshot names: `03-qa.png`. */
    name: string;
    url: string;
    /** The accessibility id (React Native testID) of the screen's root, which the Appium driver waits for. */
    rootId?: string;
}

export const IOS_CONFIGURATIONS = ["Debug", "Release"] as const;
export type IosConfiguration = (typeof IOS_CONFIGURATIONS)[number];

export interface IosAppConfig {
    /** The bundle id, or a function that reads it from the app's folder (an Expo app's `app.json`). */
    bundleId: string | ((appDir: string) => string);
    build: IosBuild;
    /** What decides that a build is out of date; without it a build counts as current until `--build always`. */
    buildInputs?: BuildInputs;
    /** The phone width in points `up` sizes a simulator for when `--width` is not given. */
    defaultWidth?: number;
    /** What a fresh install needs before it runs unattended (`first-run`, `up`). */
    firstRun?: FirstRunSetup;
}

export interface FirstRunSetup {
    /** `simctl privacy grant` services. */
    privacy?: SimctlPrivacyService[];
    /** `idb approve` services (camera, notification) that simctl cannot grant; used only where idb is installed. */
    idbApprove?: string[];
    /** The URL scheme `idb approve … url` pre-approves, so a plain `simctl openurl` raises no "Open in" alert. */
    scheme?: string;
    /** User defaults written into the app's domain, e.g. a dev menu that would open at launch. */
    defaults?: Array<{ key: string; value: string[] }>;
}

/** How to build the app for a simulator with `xcodebuild` (Expo's `run:ios` cannot find DeviceHub on Xcode 27). */
export interface IosBuild {
    /** The workspace, relative to the app folder. */
    workspace: string;
    scheme: string;
    configuration: IosConfiguration;
    /** The `.app` name under `Build/Products/<configuration>-iphonesimulator/`. */
    productName: string;
    /** Extra `KEY=value` build settings, e.g. a deployment target a dependency needs. */
    buildSettings?: Record<string, string>;
}

/**
 * Globs relative to the app folder. `native` files go into every build; `js` files only into a build that carries its
 * JavaScript (Release). A build is stale when any matched file changed since it was built.
 */
export interface BuildInputs {
    native: string[];
    js: string[];
}

const routeSchema = z.object({ name: z.string().min(1), url: z.string().min(1), rootId: z.string().optional() });
const fn = <T>(label: string) =>
    z.custom<T>((value) => typeof value === "function", { message: `${label}: a function` });

const iosSchema = z.object({
    bundleId: z.union([z.string().min(1), fn<(appDir: string) => string>("bundleId")]),
    build: z.object({
        workspace: z.string().min(1),
        scheme: z.string().min(1),
        configuration: z.enum(IOS_CONFIGURATIONS),
        productName: z.string().min(1),
        buildSettings: z.record(z.string(), z.string()).optional(),
    }),
    buildInputs: z.object({ native: z.array(z.string()), js: z.array(z.string()) }).optional(),
    defaultWidth: z.number().positive().optional(),
    firstRun: z
        .object({
            privacy: z.array(z.enum(SIMCTL_PRIVACY_SERVICES)).optional(),
            idbApprove: z.array(z.string()).optional(),
            scheme: z.string().optional(),
            defaults: z.array(z.object({ key: z.string(), value: z.array(z.string()) })).optional(),
        })
        .optional(),
});

const configSchema: z.ZodType<MobileProjectConfig> = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "id: letters, digits, dot, dash or underscore"),
    title: z.string().optional(),
    appDir: z.string().optional(),
    routes: z.union([z.array(routeSchema), fn<(appDir: string) => MobileRoute[]>("routes")]).optional(),
    metro: z.object({ defaultPort: z.number().int().positive() }).optional(),
    platforms: z.object({ ios: iosSchema.optional() }),
});

/** The file names a project's config may have, checked in each folder from the working folder up. */
export const MOBILE_CONFIG_FILES = ["mobile.config.ts", "e2e/mobile.config.ts"] as const;

/** A loaded project: its config and where it lives. */
export interface MobileProject {
    configPath: string;
    /** The absolute app folder. */
    appDir: string;
    config: MobileProjectConfig;
}

/** The nearest config file at or above `cwd`; null when there is none up to the file system root. */
export function findMobileConfig(cwd: string): string | null {
    let dir = resolve(cwd);
    const { root } = parse(dir);

    while (true) {
        for (const name of MOBILE_CONFIG_FILES) {
            const candidate = join(dir, name);

            if (existsSync(candidate) && statSync(candidate).isFile()) {
                return candidate;
            }
        }

        if (dir === root) {
            return null;
        }

        dir = dirname(dir);
    }
}

/** Checks a config's shape; throws with every problem and the file it came from. */
export function parseMobileConfig(raw: unknown, source: string): MobileProjectConfig {
    const result = configSchema.safeParse(raw);

    if (!result.success) {
        throw new Error(`invalid mobile config ${source}:\n${z.prettifyError(result.error)}`);
    }

    return result.data;
}

/**
 * Loads the project: the file `--config` names, else the nearest `mobile.config.ts` (or `e2e/mobile.config.ts`) at or
 * above `cwd`. A relative `--config` resolves from `cwd`.
 */
export async function loadMobileProject(options: { config?: string; cwd: string }): Promise<MobileProject> {
    const configPath = options.config
        ? isAbsolute(options.config)
            ? options.config
            : resolve(options.cwd, options.config)
        : findMobileConfig(options.cwd);

    if (!configPath) {
        throw new Error(
            `no ${MOBILE_CONFIG_FILES.join(" or ")} at or above ${options.cwd}; pass --config <file> or add one to the project`
        );
    }

    if (!existsSync(configPath)) {
        throw new Error(`the mobile config ${configPath} does not exist`);
    }

    const loaded = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
    const config = parseMobileConfig(loaded.default, configPath);
    const appDir = resolve(dirname(configPath), config.appDir ?? ".");
    log.debug({ configPath, id: config.id, appDir, platforms: Object.keys(config.platforms) }, "mobile project loaded");
    return { configPath, appDir, config };
}

/** The project's screens; a route function runs against the app folder. */
export function projectRoutes(project: MobileProject): MobileRoute[] {
    const { routes } = project.config;

    if (!routes) {
        return [];
    }

    return typeof routes === "function" ? routes(project.appDir) : routes;
}

/** The iOS part of a project with its bundle id read; throws when the project has no iOS app. */
export interface IosApp extends Omit<IosAppConfig, "bundleId"> {
    bundleId: string;
    buildInputs: BuildInputs;
    firstRun: Required<Omit<FirstRunSetup, "scheme">> & Pick<FirstRunSetup, "scheme">;
}

export function iosApp(project: MobileProject): IosApp {
    const ios = project.config.platforms.ios;

    if (!ios) {
        throw new Error(`${project.configPath} has no platforms.ios`);
    }

    const bundleId = typeof ios.bundleId === "function" ? ios.bundleId(project.appDir) : ios.bundleId;
    const firstRun = {
        privacy: ios.firstRun?.privacy ?? [],
        idbApprove: ios.firstRun?.idbApprove ?? [],
        scheme: ios.firstRun?.scheme,
        defaults: ios.firstRun?.defaults ?? [],
    };
    return { ...ios, bundleId, buildInputs: ios.buildInputs ?? { native: [], js: [] }, firstRun };
}
