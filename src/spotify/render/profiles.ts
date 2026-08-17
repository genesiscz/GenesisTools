/**
 * Profiles and the data check are inventories, not analytics, so they use the shared
 * port-style box tables rather than this tool's dense analytics tables.
 */
import type { ProfileDetail, ProfileListReport } from "@app/spotify/lib/reports/profiles";
import { int } from "@app/spotify/render/text";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    truncateDisplay,
} from "@genesiscz/utils/table";
import pc from "picocolors";

export function renderProfileList(r: ProfileListReport): void {
    if (!r.profiles.length) {
        out.println("no profiles yet. Add one with:");
        out.println(
            suggestCommand("tools spotify", {
                replaceCommand: [
                    "profile",
                    "add",
                    "me",
                    "--history",
                    "<unzipped export dir>",
                    "--data",
                    "<harvest dir>",
                ],
            })
        );

        return;
    }

    renderCliHeader("Spotify Profiles", r.registryPath);
    const table = createBoxTable(["", "NAME", "LABEL", "HISTORY", "LIBRARY", "TZ"]);
    for (const p of r.profiles) {
        table.push([
            p.isDefault ? pc.green("*") : " ",
            pc.white(p.name),
            p.label,
            p.historyDir
                ? p.historyExists
                    ? truncateDisplay(p.historyDir, 46)
                    : pc.red(`${truncateDisplay(p.historyDir, 38)} (missing)`)
                : pc.gray("—"),
            p.dataDir
                ? p.dataExists
                    ? truncateDisplay(p.dataDir, 46)
                    : pc.red(`${truncateDisplay(p.dataDir, 38)} (missing)`)
                : pc.gray("—"),
            p.timezone,
        ]);
    }

    out.println(table.toString());
    out.println(pc.gray(`  ${r.profiles.length} profile(s) · * = default`));
}

export function renderProfileDetail(d: ProfileDetail): void {
    renderCliHeader(`Profile ${d.profile.name}`, d.profile.label);
    renderCliKeyRow("label", d.profile.label, 14);
    renderCliKeyRow("timezone", d.profile.timezone, 14);
    renderCliKeyRow("history", d.profile.historyDir ?? "—", 14);
    renderCliKeyRow("library", d.profile.dataDir ?? "—", 14);
    renderCliKeyRow("events", d.events ? int(d.events) : "—", 14);
    renderCliKeyRow("span", d.span ? `${d.span.from.slice(0, 10)} to ${d.span.to.slice(0, 10)}` : "—", 14);
    renderCliKeyRow("liked tracks", d.likedTracks ? int(d.likedTracks) : "—", 14);
    renderCliKeyRow("added", d.profile.addedAt.slice(0, 10), 14);
}

export function renderProfileSaved(d: ProfileDetail): void {
    out.println(
        `saved profile ${pc.green(d.profile.name)} ${formatDotStatus(d.events ? "ok" : "warn", d.events ? "history loaded" : "no history yet")}`
    );
    renderProfileDetail(d);
}
