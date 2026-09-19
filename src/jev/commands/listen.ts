import {
    type AppSwitchTarget,
    frontmostTarget,
    isBrowserApp,
    switchableApps,
} from "@app/control/lib/decision/frontmost";
import { NativeControlDriver } from "@app/control/lib/decision/native";
import { selectedProvider } from "@genesiscz/utils/ai/evaluation/cli";
import { createEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import { savedJevSettings } from "@genesiscz/utils/ai/evaluation/settings";
import {
    DEFAULT_WAKE_PHRASES,
    openLiveStt,
    parseLanguages,
    parseSttProvider,
    parseWakePhrases,
    STT_PROVIDER_IDS,
} from "@genesiscz/utils/ai/stt";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { openVoiceCapsule } from "@genesiscz/utils/macos/voice-capsule";
import { profiler } from "@genesiscz/utils/profile";
import type { Command } from "commander";
import { failPlain, parseEnum, printResult, withSigint } from "../lib/cli-output";
import { pumpAudio, resolveCapsule, showOnCapsule } from "../lib/listen/audio";
import { createBrowserListenSurface } from "../lib/listen/browser-surface";
import { actOnSurface } from "../lib/listen/dispatch";
import { createMenuCandidates } from "../lib/listen/menu-candidates";
import { axView, createListenPipeline, type ListenDecision } from "../lib/listen/pipeline";
import { speakDecision } from "../lib/listen/speak";
import { type BoundTarget, browserTabTitle, type ListenTarget, resolveListenTarget } from "../lib/listen/target";
import { loadTranscript } from "../lib/listen/transcript";
import { appSwitchCandidates } from "../lib/listen/verbs";
import { compactResult } from "../lib/output-shape";
import type { PrefetchPayload } from "../lib/prefetch";
import { readWakeGate } from "../lib/wake/wake";

const prof = profiler.scope("jev-listen");
const { log } = logger.scoped("jev-listen");

const WAKE_MODES = ["off", "contains", "jev"] as const;
const SURFACES = ["ax", "browser", "auto"] as const;
const SCOPES = ["auto", "window", "chrome"] as const;
const _MENU_ITEM_CAP = 120;
const DEFAULT_MAX_SECONDS = 60;
/**
 * How long a switchable-app list stays good.
 *
 * A decision runs on every PARTIAL transcript once a session is armed, several times a second
 * while someone is speaking, and each one rebuilt this list by spawning `ps` and the native
 * binary to enumerate every on-screen window. The set of running apps cannot meaningfully
 * change between two partials of one sentence, so those spawns bought nothing. This mirrors
 * WAKE_EVAL_INTERVAL_MS, which already coalesces the wake evaluation over the same stream.
 */
const APP_LIST_TTL_MS = 500;

interface ListenOptions {
    app?: string;
    windowId?: string;
    windowIndex?: string;
    scope?: string | boolean;
    menus?: boolean;
    prepare?: boolean;
    expectedUrl?: string;
    depth?: string;
    pageUrl?: string;
    pageIndex?: string;
    url?: string;
    inputs?: string;
    stt?: string | boolean;
    account?: string;
    language?: string;
    pcmIn?: string;
    goal?: string;
    gate?: string;
    maxSeconds?: string;
    transcript?: string;
    surface?: string | boolean;
    port: string;
    wake?: string;
    wakeMode?: string | boolean;
    continuous?: boolean;
    fromWake?: boolean;
    dispatchAhead?: boolean;
    capsule?: string | boolean;
    dryRun?: boolean;
    forceAct?: boolean;
    yes?: boolean;
    json?: boolean;
}

export function registerListen(program: Command): void {
    program
        .command("listen")
        .description("Live speech into a typed Jev chooser over one app's observed actions")
        .option("--app <name>", "Native AX target app name or PID")
        .option("--window-id <id>", "Pin one window")
        .option("--window-index <n>", "On-screen window index when the app has several (0 = frontmost)", "0")
        .option(
            "--scope [scope]",
            "AX scope: auto (the whole window), window, or chrome (browser tab strip and toolbar only, page content omitted)"
        )
        .option("--no-menus", "Do not offer the app's menu bar items as choosable targets (on by default)")
        .option("--stt [provider]", `Live STT provider: ${STT_PROVIDER_IDS.join("|")}`)
        .option("--account <id>", "tools ai account id or name for the STT provider")
        .option(
            "--language <codes>",
            "ISO 639-1 codes in priority order, e.g. cs,en (default: the wake marker's, else auto)"
        )
        .option("--prepare", "Verify the semantic target natively before each dispatch (web fields use paste/keys)")
        .option("--expected-url <url>", "Pin the observed browser document; a different AXURL blocks the session")
        .option("--depth <n>", "AX traversal depth for see; raised automatically when the tree is deeper")
        .option("--pcm-in <input>", "Audio source: mic (GenesisTools.app), -, a s16le file, or ffmpeg[:device]", "mic")
        .option("--transcript <file>", "Replay a JSONL transcript instead of audio (provider fixture)")
        .option("--goal <text>", "Standing goal; otherwise the transcript is the intent")
        .option("--gate <n>", "Admission probability (default 0.8, or tools jev config set gate)")
        .option("--max-seconds <n>", `Session budget in seconds (default ${DEFAULT_MAX_SECONDS})`)
        .option("--surface [kind]", `ax, browser, or auto (chrome verbs need --port)`)
        .option("--port <n>", "CDP port for the browser surface", "9222")
        .option("--page-url <text>", "Browser surface: select the page whose URL contains this text")
        .option("--page-index <n>", "Browser surface: select the page with this list_pages index")
        .option("--url <url>", "Browser surface: open this URL as a NEW page before the first snapshot")
        .option("--inputs <json>", "Browser surface: JSON object of values Jev may type; it never invents text")
        .option("--wake <phrases>", "Comma-separated wake phrases", DEFAULT_WAKE_PHRASES.join(","))
        .option("--wake-mode [mode]", "off, contains, or jev", "off")
        .option("--continuous", "Stay armed after a dispatch until stop/cancel")
        .option("--from-wake", "Transcript replay: keep events at or after the last wake phrase")
        .option("--dispatch-ahead", "Dispatch a prefetch hit without a second see")
        .option("--capsule [mode]", "Floating voice capsule overlay: on or off (default: on with a mic in a TTY)")
        .option("--dry-run", "Never dispatch")
        .option("--force-act", "Allow dispatch from a pipe")
        .option("--yes", "Allow a destructive wake command without a spoken confirmation")
        .option("--json", "Full result including snapshot tokens")
        .action(async (options: ListenOptions) => {
            try {
                await runListen(program, options);
            } catch (error) {
                failPlain(error, { command: "jev listen" });
            }
        });
}

async function runListen(program: Command, options: ListenOptions): Promise<void> {
    // A flag always wins, then whatever `tools jev config set` saved, then the built-in default.
    const saved = savedJevSettings();
    const providerRaw = options.stt === undefined || options.stt === true ? undefined : options.stt;
    const provider = parseSttProvider(
        providerRaw ?? (options.transcript ? "fixture" : isInteractive() ? (saved.stt ?? "deepgram") : "")
    );
    const wakeMode = parseEnum(options.wakeMode, WAKE_MODES, "--wake-mode", "tools jev listen");
    const surface = parseEnum(options.surface ?? "ax", SURFACES, "--surface", "tools jev listen");
    if (!wakeMode || !surface) {
        return;
    }

    if (!options.transcript && provider === "fixture") {
        ui.err("Provider fixture needs --transcript <file>.");
        ui.info(suggestCommand("tools jev listen", { add: ["--transcript", "session.jsonl"] }));
        process.exitCode = 1;
        return;
    }

    const wantsCapsule = resolveCapsule(options);
    if (wantsCapsule === undefined) {
        return;
    }

    // Without --app the target follows the focused window. This is the first native call, so
    // every cheap argument check above runs before it.
    const target = surface === "browser" ? null : await resolveListenTarget(options);
    if (surface !== "browser" && !target) {
        return;
    }

    const scope = parseEnum(options.scope ?? saved.scope ?? "auto", SCOPES, "--scope", "tools jev listen");
    if (!scope) {
        return;
    }

    if (target) {
        ui.info(`target ${target.app}${target.title ? ` "${target.title}"` : ""} (${target.source}, scope ${scope})`);
    }

    const dryRun = options.dryRun === true || (!isInteractive() && options.forceAct !== true);
    const gate = readWakeGate();
    const phrases = parseWakePhrases(options.wake ?? gate.word ?? DEFAULT_WAKE_PHRASES.join(","));
    const savedLanguage = saved.language === "auto" ? undefined : saved.language;
    const languages = parseLanguages(options.language ?? gate.languages?.join(",") ?? savedLanguage);
    const maxSeconds = Number(options.maxSeconds) || saved.maxSeconds || DEFAULT_MAX_SECONDS;
    const menus = options.menus !== false && saved.menus !== "off";
    log.info(
        {
            provider,
            account: options.account,
            languages,
            pcmIn: options.pcmIn,
            transcript: options.transcript,
            app: target?.app,
            targetSource: target?.source,
            scope,
            menus,
            surface,
            wakeMode,
            dryRun,
            maxSeconds,
            capsule: wantsCapsule,
        },
        "jev listen starting"
    );

    await withSigint(async (sigint) => {
        const controller = new AbortController();
        const deadline = setTimeout(() => {
            log.info({ maxSeconds }, "listen session budget reached");
            controller.abort();
        }, maxSeconds * 1000);
        sigint.addEventListener("abort", () => controller.abort());
        let appList: { at: number; value: Promise<AppSwitchTarget[]> } | undefined;
        const recentSwitchableApps = () => {
            if (appList && Date.now() - appList.at < APP_LIST_TTL_MS) {
                return appList.value;
            }

            const value = prof
                .measureAsync("switchable-apps", () => switchableApps({ signal: controller.signal }))
                .catch((error: unknown) => {
                    // A failed read must not be cached, or one transient refusal silences "switch
                    // to <app>" for the rest of the half second and hides the reason.
                    appList = undefined;
                    throw error;
                });
            appList = { at: Date.now(), value };
            return value;
        };
        const stopSession = prof.start("session");
        const capsule = wantsCapsule ? openVoiceCapsule({ signal: controller.signal }) : null;
        let browser: ReturnType<typeof createBrowserListenSurface> | undefined;
        try {
            const events = options.transcript
                ? await loadTranscript(options.transcript, options.fromWake === true, phrases)
                : undefined;
            const session = await openLiveStt({
                provider,
                account: options.account,
                languages,
                events,
                signal: controller.signal,
            });
            const pump =
                provider === "fixture"
                    ? Promise.resolve()
                    : pumpAudio(session, options.pcmIn ?? "mic", controller.signal, capsule);
            const bind = (bound: ListenTarget): BoundTarget => ({
                app: bound.app,
                driver: new NativeControlDriver({
                    app: bound.app,
                    windowId: options.windowId ? Number(options.windowId) : undefined,
                    windowIndex: options.windowId ? undefined : Number(options.windowIndex ?? 0),
                    scope: scope === "auto" ? "window" : scope,
                    prepare: options.prepare === true,
                    expectedURL: options.expectedUrl,
                    depth: options.depth ? Number(options.depth) : undefined,
                }),
                menus: menus ? createMenuCandidates(bound.app, controller.signal) : undefined,
            });
            let current = target ? bind(target) : undefined;
            // Without --app the target follows the focused window between utterances: the app you
            // are looking at when you speak is the one you mean, and the WindowServer knows it
            // exactly. The start-of-session pick is only a guess until the first utterance.
            const retarget = async (): Promise<BoundTarget | undefined> => {
                if (!target || options.app) {
                    return current;
                }

                const next = await prof.measureAsync("frontmost", () => frontmostTarget({ signal: controller.signal }));
                // Only a WindowServer-confirmed focus may retarget. While you watch this terminal
                // the frontmost app is the terminal itself, and the z-order fallback behind it is
                // a guess; acting on that guess would move the target under your feet mid-session.
                if (next?.focused && next.app !== current?.app) {
                    log.info({ from: current?.app, to: next.app, title: next.title }, "listen target followed focus");
                    ui.info(`target ${next.app}${next.title ? ` "${next.title}"` : ""} (focus)`);
                    current = bind({ app: next.app, title: next.title, source: "frontmost" });
                }

                return current;
            };
            const port = Number(options.port) || saved.browser?.port || 9222;
            // A browser's page lives behind the DevTools Protocol, not in its accessibility tree,
            // so a browser target takes the CDP surface unless --surface says otherwise. The AX
            // route cannot serve one: a live page never settles, so every `see` refuses with "UI
            // changed during observation", and a page that does settle nests too deep to observe.
            const useBrowserSurface =
                surface === "browser" || (options.surface === undefined && target !== null && isBrowserApp(target.app));
            if (useBrowserSurface && surface !== "browser") {
                ui.info(`target is a browser; reading the page over CDP on port ${port}`);
                log.info({ app: target?.app, port }, "browser target: using the CDP page surface");
            }
            browser = useBrowserSurface
                ? createBrowserListenSurface({
                      port,
                      pageUrl: options.pageUrl,
                      pageTitle: options.pageUrl ? undefined : browserTabTitle(target?.title),
                      pageIndex: options.pageIndex === undefined ? undefined : Number(options.pageIndex),
                      url: options.url,
                      inputs: options.inputs ? SafeJSON.parse(options.inputs) : undefined,
                  })
                : undefined;
            const pipeline = createListenPipeline({
                dryRun,
                dispatchAhead: options.dispatchAhead === true,
                continuous: options.continuous === true,
                gate: Number(options.gate) || saved.gate || 0.8,
                narrowAt: saved.narrowAt,
                confirmRisk: saved.confirmRisk,
                historyDepth: saved.historyDepth,
                announce: saved.speak === "off" || saved.speak === undefined ? undefined : speakDecision,
                goal: options.goal,
                wake: { mode: wakeMode, phrases, confirmDestructive: options.yes === true },
                chromeVerbs: surface !== "ax",
                menuItems: menus && target ? async () => current?.menus?.items() ?? [] : undefined,
                // "switch to <app>" is offered on every utterance, so the session is never stuck
                // on the app it happened to start against.
                extraCandidates: async () => appSwitchCandidates(await recentSwitchableApps()),
                signal: controller.signal,
                evaluate: await createEvaluator({ provider: selectedProvider(program) }),
                surface: browser ?? {
                    see: async () => {
                        const bound = await retarget();
                        if (!bound) {
                            throw new Error(
                                "listen needs --app for an observed native target, or --surface browser for a CDP page."
                            );
                        }

                        return axView(await bound.driver.observe({ signal: controller.signal }));
                    },
                    act: async (payload: PrefetchPayload, view) =>
                        actOnSurface({
                            payload,
                            observation: view.observation,
                            driver: current?.driver,
                            surface,
                            port,
                            menus: current?.menus,
                            onAppSwitch: () => {
                                current = undefined;
                            },
                        }),
                },
            });
            const decisions: ListenDecision[] = [];
            try {
                for await (const event of session.events()) {
                    showOnCapsule(capsule, event);
                    let decision: ListenDecision;
                    try {
                        decision = await pipeline.decide(event);
                    } catch (error) {
                        if (controller.signal.aborted || options.continuous !== true) {
                            throw error;
                        }

                        log.warn({ error }, "utterance failed; staying armed because the session is continuous");
                        ui.err(`skipped   ${error instanceof Error ? error.message : String(error)}`);
                        continue;
                    }

                    decisions.push(decision);
                    capsule?.send({
                        kind: "decision",
                        status: decision.status,
                        label: decision.label ?? decision.choice ?? undefined,
                        probability: decision.probability,
                    });
                    if (decision.transcript.length > 0 || decision.status !== "hold") {
                        ui.info(
                            `${decision.status.padEnd(7)} ${decision.reason.padEnd(22)} ${decision.choice ?? "-"} ${decision.transcript}`
                        );
                    }

                    if (decision.status === "stop" && !options.continuous) {
                        break;
                    }
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    throw error;
                }
            }

            await session.close();
            await pump.catch((error: unknown) => {
                log.warn({ error }, "audio pump ended with an error");
            });
            const summary = {
                provider,
                dryRun,
                wakeMode,
                surface,
                decisions,
                counts: countBy(decisions),
            };
            printResult(compactResult(summary, { verbose: options.json === true }));
        } finally {
            await browser?.close();
            clearTimeout(deadline);
            stopSession();
            await capsule?.close();
        }
    });
}

function countBy(decisions: ListenDecision[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const decision of decisions) {
        counts[decision.status] = (counts[decision.status] ?? 0) + 1;
    }

    return counts;
}
