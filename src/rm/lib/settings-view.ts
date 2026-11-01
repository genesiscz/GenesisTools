import { toolCommand } from "@genesiscz/utils/cli";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { isRootActive, type RmConfig, type RmPreset, type RmRoot } from "@genesiscz/utils/rm";
import { stripAnsi } from "@genesiscz/utils/string";
import { formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

/** Rows padded by visible width (a dot status cell carries color codes), the header dim, two spaces apart. */
function columns(headers: readonly string[], rows: readonly string[][]): string[] {
    const widths = headers.map((header, i) =>
        Math.max(header.length, ...rows.map((row) => stripAnsi(row[i] ?? "").length))
    );
    const line = (cells: readonly string[]) =>
        cells
            .map((cell, i) => (i === cells.length - 1 ? cell : cell + " ".repeat(widths[i] - stripAnsi(cell).length)))
            .join("  ")
            .trimEnd();
    return [pc.dim(line(headers)), ...rows.map(line)];
}

function yesNo(value: boolean): string {
    return value ? "yes" : "no";
}

function list(values: readonly string[]): string {
    return values.length > 0 ? values.join(", ") : "-";
}

/**
 * The `config set` settings a listing shows, each with how it reads its value. `enable-profile` is the inverse of
 * `disable-profile`, so the disabled list stands for both.
 */
const SHOWN_SETTINGS: ReadonlyArray<{ key: string; value: (config: RmConfig) => string }> = [
    { key: "approval", value: (c) => c.approval },
    { key: "notify-on-request", value: (c) => c.notify.onRequest },
    { key: "ask-action", value: (c) => c.askAction },
    { key: "aside-unsaved", value: (c) => yesNo(c.asideUnsaved) },
    { key: "session-scratch", value: (c) => yesNo(c.allowSessionScratch) },
    { key: "own-files", value: (c) => yesNo(c.allowOwnFiles) },
    { key: "grace-preset", value: (c) => `${c.grace.presetMinutes} min` },
    { key: "grace-other", value: (c) => `${c.grace.otherMinutes} min` },
    { key: "trash-root", value: (c) => c.trashRoot },
    { key: "enable-preset", value: (c) => list(c.enabledPresets) },
    { key: "disable-preset", value: (c) => list(c.disabledPresets) },
    { key: "disable-profile", value: (c) => list(c.disabledProfiles) },
];

export interface ConfigView {
    /** The saved file. */
    base: RmConfig;
    /** The file with this caller's profiles applied. */
    effective: RmConfig;
    /** The profiles that apply to this caller, by name. */
    profiles: readonly string[];
    defaults: RmConfig;
    path: string;
}

/** `tools rm config`: one row per setting with its value, the default, and where the value comes from. */
export function renderConfig(view: ConfigView): string[] {
    const rows = SHOWN_SETTINGS.map(({ key, value }) => {
        const now = value(view.effective);
        const saved = value(view.base);
        const fallback = value(view.defaults);
        const from = now !== saved ? `profile ${view.profiles.join(", ")}` : saved !== fallback ? "file" : "default";
        return [key, now === fallback ? now : pc.yellow(now), fallback, from];
    });

    return [
        pc.dim(view.path),
        ...columns(["SETTING", "VALUE", "DEFAULT", "FROM"], rows),
        "",
        pc.dim(`Change (a person): ${toolCommand("rm")} config set <setting> <value>`),
    ];
}

/** `~` for the home folder, as a listing shows a path. */
function homeShort(path: string, home: string): string {
    return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** `tools rm presets`: one row per preset, its state as a dot cell, and the opt-in command once. */
export function renderPresets(input: {
    all: readonly RmPreset[];
    enabled: ReadonlySet<string>;
    disabled: readonly string[];
    home: string;
}): string[] {
    const rows = input.all.map((preset) => {
        const state = input.enabled.has(preset.id)
            ? formatDotStatus("ok", "on")
            : preset.optIn && !input.disabled.includes(preset.id)
              ? formatDotStatus("warn", "opt-in")
              : formatDotStatus("err", "off");
        const deletes = preset.within
            ? `every folder in ${homeShort(preset.within, input.home)}`
            : preset.names.join(", ");
        const nextTo = [
            preset.markers ? `next to ${preset.markers.join(" or ")}` : "",
            preset.parentNames ? `inside ${preset.parentNames.join(" or ")}` : "",
        ]
            .filter(Boolean)
            .join(", ");
        return [
            preset.id,
            state,
            truncateDisplay(deletes, 40),
            nextTo ? truncateDisplay(nextTo, 34) : "-",
            truncateDisplay(preset.description, 60),
        ];
    });
    const rm = toolCommand("rm");

    return [
        ...columns(["ID", "STATE", "DELETES", "NEXT TO", "WHAT"], rows),
        "",
        pc.dim(
            `Turn one on or off (a person): ${rm} config set enable-preset <id>, ${rm} config set disable-preset <id>`
        ),
    ];
}

function rootScope(root: RmRoot): string {
    const until = root.expiresAt ? formatLocalDateTimeStamp(root.expiresAt, { seconds: false }) : null;

    if (until && !isRootActive(root, root.session ?? null)) {
        return `expired ${until}`;
    }

    const who = root.session ? `session ${root.session.slice(0, 8)}` : "always";
    return until ? `${who} until ${until}` : who;
}

/** `tools rm roots`: one row per trusted root, its scope, when it was added (local time) and how, and its note. */
export function renderRoots(roots: readonly RmRoot[], home: string): string[] {
    if (roots.length === 0) {
        return [`No trusted roots. Add one (a person): ${toolCommand("rm")} roots add <dir>`];
    }

    return columns(
        ["PATH", "SCOPE", "ADDED", "NOTE"],
        roots.map((root) => [
            homeShort(root.path, home),
            rootScope(root),
            `${formatLocalDateTimeStamp(root.addedAt, { seconds: false })} ${pc.dim(root.via)}`,
            root.note ?? "-",
        ])
    );
}
