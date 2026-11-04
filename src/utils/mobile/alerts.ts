import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { idb, idbAvailable } from "./idb";
import { WdaClient } from "./wda";

const log = logger.child({ component: "mobile.alerts" });

/** A system alert on the simulator: its whole text (title and message) and, when the backend can list them, its buttons. */
export interface SystemAlert {
    text: string;
    buttons: string[];
}

/**
 * Which button a known system alert gets. `choose` returns the labels to try in order (iOS words a button differently
 * across versions), or null to leave the alert alone. Every rule answers only for the app under test: an alert of
 * another app, and an alert no rule knows (the app's own `Alert.alert`, such as a destructive confirmation a spec
 * asserts on), is never touched.
 */
export interface AlertRule {
    name: string;
    match: RegExp;
    choose(match: RegExpMatchArray, appName: string): string[] | null;
}

const ownApp = (named: string | undefined, appName: string) => Boolean(appName) && named === appName;

export const SYSTEM_ALERT_RULES: AlertRule[] = [
    {
        // "Open in <app>?" after a plain `simctl openurl`. Open for our app; Cancel for another build of the same scheme,
        // so a link never lands in the wrong build.
        name: "open-in",
        match: /Open in [“"](.+?)[”"]\?/,
        choose: (match, appName) => (appName ? (ownApp(match[1], appName) ? ["Open"] : ["Cancel"]) : null),
    },
    {
        name: "notifications",
        match: /[“"](.+?)[”"] Would Like to Send You Notifications/,
        choose: (match, appName) => (ownApp(match[1], appName) ? ["Allow"] : null),
    },
    {
        name: "local-network",
        match: /[“"](.+?)[”"] Would Like to Find and Connect to Devices on Your Local Network/,
        choose: (match, appName) => (ownApp(match[1], appName) ? ["Allow", "OK"] : null),
    },
    {
        name: "location",
        match: /Allow [“"](.+?)[”"] to use your location\?/,
        choose: (match, appName) => (ownApp(match[1], appName) ? ["Allow While Using App", "Allow Once"] : null),
    },
    {
        name: "tracking",
        match: /Allow [“"](.+?)[”"] to track your activity/,
        choose: (match, appName) => (ownApp(match[1], appName) ? ["Ask App Not to Track"] : null),
    },
    {
        // Camera, microphone, photos, contacts, calendars, Face ID: one sentence shape on every iOS version.
        name: "access",
        match: /[“"](.+?)[”"] Would Like to (?:Access|Use)/,
        choose: (match, appName) =>
            ownApp(match[1], appName) ? ["Allow", "OK", "Allow Full Access", "Allow Access to All Photos"] : null,
    },
    {
        name: "save-password",
        match: /Save Password\?|Would you like to save this password/,
        choose: () => ["Not Now"],
    },
];

export interface AlertDecision {
    rule: string | null;
    buttons: string[] | null;
}

/** The rule that matches an alert's text and the buttons it picks; `buttons` null leaves the alert alone. */
export function decideAlert(text: string, appName: string, rules: AlertRule[] = SYSTEM_ALERT_RULES): AlertDecision {
    for (const rule of rules) {
        const match = text.match(rule.match);

        if (match) {
            return { rule: rule.name, buttons: rule.choose(match, appName) };
        }
    }

    return { rule: null, buttons: null };
}

/** How the watcher reads and answers an alert. One implementation per way of reaching the simulator's UI. */
export interface AlertBackend {
    readonly kind: AlertBackendKind;
    read(): Promise<SystemAlert | null>;
    /** Taps the first of these labels the alert has; returns the label tapped, or null when none matched. */
    tap(alert: SystemAlert, labels: string[]): Promise<string | null>;
}

export type AlertBackendKind = "wda" | "idb";

/** WebDriverAgent's session-less alert routes. WDA runs only while an Appium session (a wdio run, a tour) uses it. */
function wdaBackend(port: number): AlertBackend {
    const wda = new WdaClient(port);
    return {
        kind: "wda",
        async read() {
            const text = await wda.alertText();
            return text === null ? null : { text, buttons: [] };
        },
        async tap(_alert, labels) {
            for (const label of labels) {
                try {
                    await wda.tapAlertButton(label);
                    return label;
                } catch (error) {
                    log.debug({ label, error }, "alert has no such button");
                }
            }

            return null;
        },
    };
}

interface IdbElement {
    AXLabel?: string | null;
    type?: string;
    frame?: { x: number; y: number; width: number; height: number };
}

/**
 * idb's accessibility dump (`idb ui describe-all`): works with no Appium and no WDA, so it can answer the alerts a
 * plain `simctl openurl` or a fresh launch raises. A tap re-reads the label under the point first, because another
 * driver may have answered the alert since the dump, and a blind tap would land on the app behind it.
 */
function idbBackend(udid: string): AlertBackend {
    let elements: IdbElement[] = [];
    return {
        kind: "idb",
        async read() {
            const stdout = await idb(["ui", "describe-all", "--udid", udid]);
            elements = stdout ? ((SafeJSON.parse(stdout, { strict: true }) as IdbElement[]) ?? []) : [];
            const labels = elements.map((element) => element.AXLabel ?? "").filter(Boolean);
            const title = labels.find((label) => SYSTEM_ALERT_RULES.some((rule) => rule.match.test(label)));

            if (!title) {
                return null;
            }

            const buttons = elements
                .filter((element) => element.type === "Button")
                .map((element) => element.AXLabel ?? "");
            return { text: labels.join("\n"), buttons };
        },
        async tap(_alert, labels) {
            for (const label of labels) {
                const button = elements.find((element) => element.type === "Button" && element.AXLabel === label);

                if (!button?.frame) {
                    continue;
                }

                const x = String(Math.round(button.frame.x + button.frame.width / 2));
                const y = String(Math.round(button.frame.y + button.frame.height / 2));
                const under = await idb(["ui", "describe-point", "--udid", udid, x, y]);

                if (!under?.includes(label)) {
                    log.debug({ label, x, y }, "the button moved or went before the tap; not tapping");
                    return null;
                }

                if ((await idb(["ui", "tap", "--udid", udid, x, y])) !== null) {
                    return label;
                }
            }

            return null;
        },
    };
}

const ALERT_BACKENDS: Record<
    AlertBackendKind,
    (context: { udid: string; wdaPort: number }) => Promise<AlertBackend | null>
> = {
    wda: async ({ wdaPort }) => ((await new WdaClient(wdaPort).ready()) ? wdaBackend(wdaPort) : null),
    idb: async ({ udid }) => (idbAvailable() ? idbBackend(udid) : null),
};

export const ALERT_BACKEND_KINDS = Object.keys(ALERT_BACKENDS) as AlertBackendKind[];

/** The first backend that can reach this simulator now, in the order asked (default: WDA, then idb). */
export async function alertBackendFor(options: {
    udid: string;
    wdaPort: number;
    order?: AlertBackendKind[];
}): Promise<AlertBackend | null> {
    for (const kind of options.order ?? ALERT_BACKEND_KINDS) {
        const backend = await ALERT_BACKENDS[kind]({ udid: options.udid, wdaPort: options.wdaPort });

        if (backend) {
            return backend;
        }
    }

    return null;
}

export interface AlertAnswer {
    at: string;
    backend: AlertBackendKind;
    text: string;
    rule: string | null;
    /** The button tapped; null when the alert was left alone (no rule, another app's, or no label matched). */
    tapped: string | null;
}

/**
 * Answers known system alerts while a run drives the app. It polls once a second, answers what a rule names, and
 * reports an alert it leaves alone once per distinct text, so a spec that waits on its own confirmation is not raced.
 */
export class AlertWatcher {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = true;
    private readonly seen = new Set<string>();
    readonly answers: AlertAnswer[] = [];

    constructor(
        private readonly options: {
            backend: AlertBackend;
            appName: string;
            rules?: AlertRule[];
            intervalMs?: number;
            onAnswer?: (answer: AlertAnswer) => void;
        }
    ) {}

    /** One read and, when a rule names a button, one tap. Returns the answer, or null when no alert is open. */
    async check(): Promise<AlertAnswer | null> {
        const { backend, appName } = this.options;
        const alert = await backend.read();

        if (!alert) {
            return null;
        }

        const decision = decideAlert(alert.text, appName, this.options.rules);
        const tapped = decision.buttons ? await backend.tap(alert, decision.buttons) : null;
        const answer: AlertAnswer = {
            at: new Date().toISOString(),
            backend: backend.kind,
            text: alert.text,
            rule: decision.rule,
            tapped,
        };

        if (tapped || !this.seen.has(alert.text)) {
            this.seen.add(alert.text);
            this.answers.push(answer);
            this.options.onAnswer?.(answer);
            log.info(answer, tapped ? "answered a system alert" : "left an alert alone");
        }

        return answer;
    }

    /** Answers alerts until none is open for `quietMs`, or the deadline passes; returns how many it tapped. */
    async answerNow(options: { timeoutMs: number; quietMs?: number }): Promise<number> {
        const deadline = Date.now() + options.timeoutMs;
        const quietMs = options.quietMs ?? 1_500;
        let quietSince = Date.now();
        let tapped = 0;

        while (Date.now() < deadline) {
            const answer = await this.check().catch((error: unknown) => {
                log.debug({ error }, "alert check failed");
                return null;
            });

            if (answer?.tapped) {
                tapped++;
                quietSince = Date.now();
                await Bun.sleep(400);
                continue;
            }

            if (Date.now() - quietSince >= quietMs) {
                break;
            }

            await Bun.sleep(Math.min(300, Math.max(0, deadline - Date.now())));
        }

        return tapped;
    }

    start(): void {
        this.stopped = false;
        const tick = async () => {
            if (this.stopped) {
                return;
            }

            try {
                await this.check();
            } catch (error) {
                log.debug({ error }, "alert check failed");
            }

            if (!this.stopped) {
                this.timer = setTimeout(tick, this.options.intervalMs ?? 1_000);
            }
        };
        void tick();
    }

    stop(): void {
        this.stopped = true;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
