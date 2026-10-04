import type { RecommendReport } from "@app/spotify/lib/reports/recommend";
import { c, heading, keyValue, line } from "@app/spotify/render/text";

const artistLink = (uri: string | null) =>
    uri?.startsWith("spotify:artist:")
        ? `https://open.spotify.com/artist/${uri.slice("spotify:artist:".length)}`
        : null;

export function renderRecommend(r: RecommendReport, limit: number): void {
    line(heading(`Discover · ${r.method.title}`, r.head.label));
    line(`  ${c.grey(r.method.description)}`);

    if (r.missingLibrary) {
        line("");
        line(`  ${c.yellow("This method needs your Liked Songs, and this profile has no harvested library.")}`);
        line(`  ${c.grey("Make it with these commands, in order:")}`);
        for (const step of r.nextSteps) {
            line(`    ${step}`);
        }

        line("");

        return;
    }

    if (r.settings.length) {
        line("");
        line(keyValue(r.settings.map((s) => [s.label, s.value])));
    }

    if (!r.recommendations.length) {
        line("");
        line(`  ${c.grey("Nothing matched. Try a wider window or a lower --min.")}`);
        line("");

        return;
    }

    for (const [i, rec] of r.recommendations.slice(0, limit).entries()) {
        line("");
        line(`  ${c.bold(`${i + 1}. ${rec.artist}`)}  ${c.grey(`score ${rec.score}`)}`);
        line(`     ${rec.reason}`);
        for (const e of rec.evidence.slice(0, 5)) {
            line(`     ${c.cyan("·")} ${e.song} ${c.grey(e.detail)}`);
        }

        if (rec.songsToTry.length) {
            line(`     ${c.grey("Songs to try:")} ${rec.songsToTry.map((s) => s.name).join(", ")}`);
        }

        if (rec.albums.length) {
            line(`     ${c.grey("Albums:")} ${rec.albums.map((a) => a.name).join(", ")}`);
        }

        const link = artistLink(rec.artistUri);
        if (link) {
            line(`     ${c.grey(link)}`);
        }
    }

    const shown = Math.min(limit, r.recommendations.length);
    if (r.catalog.covered < Math.min(shown, r.limit)) {
        line("");
        line(
            `  ${c.grey(`Songs to try: ${r.catalog.covered} of ${shown} picks have them. Fetch the rest: tools spotify harvest --artists --auto`)}`
        );
    }

    line("");
}
