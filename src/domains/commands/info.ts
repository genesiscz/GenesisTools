import { money, priceCell, statusCell } from "@app/domains/lib/display";
import { parseDomain } from "@app/domains/lib/domain";
import { domainInfo } from "@app/domains/lib/info";
import { out } from "@genesiscz/utils/logger";
import { renderCliHeader, renderCliKeyRow, renderCliSection } from "@genesiscz/utils/table";
import { Command } from "commander";
import pc from "picocolors";

const DAY_MS = 86_400_000;
const KEY_WIDTH = 13;

function row(key: string, value: string): void {
    renderCliKeyRow(key, value, KEY_WIDTH);
}

export function createInfoCommand(): Command {
    return new Command("info")
        .alias("whois")
        .description("Everything about one name: status, price, registrar, expiry, for-sale signals, history, vibe")
        .argument("<domain>", "domain name")
        .option("--no-history", "skip the Wayback Machine and certificate lookups")
        .option("--json", "print JSON to stdout")
        .action(async (input: string, opts) => {
            const parsed = parseDomain(input);
            if (!parsed) {
                out.log.error(`Not a domain name: "${input}"`);
                process.exitCode = 1;
                return;
            }

            const spinner = opts.json ? null : out.spinner();
            spinner?.start(`Looking up ${parsed.domain}`);
            const info = await domainInfo(parsed, { history: opts.history });
            spinner?.stop(parsed.domain);
            if (opts.json) {
                out.result(info);
                return;
            }

            renderCliHeader(info.domain, info.unicode ?? `.${parsed.tld}`);
            row("Status", statusCell(info.check.status));
            row("Quote", priceCell(info.check.price));
            if (info.listPrice) {
                row(
                    "TLD list",
                    pc.dim(`${money(info.listPrice.registration)} first year, ${money(info.listPrice.renewal)} renewal`)
                );
            }

            if (info.restriction) {
                row("Rule", pc.yellow(info.restriction.note));
            }

            if (info.parking || info.landing?.forSaleText) {
                renderCliSection("For sale?");
                if (info.parking) {
                    row("Signal", pc.yellow(`parked at ${info.parking}: likely for sale`));
                }

                if (info.landing?.forSaleText) {
                    row("Page", pc.yellow("the website says the name is for sale"));
                }

                if (info.landing?.finalUrl) {
                    row("Lands on", pc.dim(info.landing.finalUrl));
                }

                row("Afternic", pc.dim(info.landing?.afternicUrl ?? `https://www.afternic.com/forsale/${info.domain}`));
            }

            const reg = info.registration;
            if (reg.found) {
                renderCliSection(`Registration (${reg.source.toUpperCase()})`);
                row("Registrar", reg.registrar ?? "—");
                if (reg.created) {
                    row("Created", reg.created.slice(0, 10));
                }

                if (reg.expires) {
                    const days = Math.floor((Date.parse(reg.expires) - Date.now()) / DAY_MS);
                    const left = days < 60 ? pc.yellow(`${days} days left`) : pc.dim(`${days} days left`);
                    row("Expires", `${reg.expires.slice(0, 10)} ${left}`);
                }

                if (reg.statuses.length) {
                    row("Status", pc.dim(reg.statuses.join(", ")));
                }
            }

            const nameservers = reg.nameservers.length ? reg.nameservers : info.dnsNameservers;
            if (nameservers.length) {
                row("Nameservers", pc.dim(nameservers.join(", ")));
            } else if (reg.found) {
                row("DNS", pc.dim("registered but not delegated (no live nameservers)"));
            }

            if (info.history || info.certificates) {
                renderCliSection("History");
                if (info.history) {
                    row(
                        "Wayback",
                        info.history.first ? `${info.history.first} .. ${info.history.last}` : pc.dim("never archived")
                    );
                }

                if (info.certificates) {
                    row(
                        "TLS certs",
                        info.certificates.count
                            ? `${info.certificates.count} (${info.certificates.first} .. ${info.certificates.last})`
                            : pc.dim("none logged")
                    );
                }
            }

            renderCliSection("Vibe");
            if (info.vibe.length) {
                const words = info.vibe.map((hit) => `"${hit.word}" (${hit.languages.join(", ")})`).join(", ");
                row("Warning", pc.red(`contains ${words}`));
            } else {
                row("Clean", pc.green("no rude words found"));
            }

            out.println(pc.dim(`Providers: ${info.check.verdicts.map((v) => `${v.provider}=${v.status}`).join(", ")}`));
        });
}
