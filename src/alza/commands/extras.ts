import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { type Command, InvalidArgumentError } from "commander";
import { RAW_READ_NAMES } from "../lib/account-extras";
import { PC_CPU_VENDORS, PC_SUGGEST_PROFILES } from "../lib/operations";
import { PC_ROLES } from "../lib/pc-build";
import { parsePcPart } from "../lib/pc-build-format";
import { parseIntArg, parseNumberArg, runAccountOperation, runOperation, TOOL } from "./run";

/** CLI doors for the phase C operations: the PC builder, account sections, order extras, checkout reads, raw reads. */

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

/** `key=value` arguments of `raw`. */
function parseRawArgs(pairs: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq <= 0) {
            throw new InvalidArgumentError(`expected key=value, got "${pair}"`);
        }

        args[pair.slice(0, eq)] = pair.slice(eq + 1);
    }

    return args;
}

interface SuggestFlags {
    profile?: string | boolean;
    cpu?: string | boolean;
    fixed?: string[];
    skip?: string[];
    maxFetches?: number;
    headroom?: number;
}

function registerPc(program: Command): void {
    const pc = program.command("pc").description("PC builder: check a parts list, or suggest one within a budget");
    pc.command("check")
        .description("Check parts for compatibility (socket, RAM, PSU, clearances, form factors, display output)")
        .argument("<parts...>", "Product codes; append :role when detection fails, e.g. BD750m7b1:psu")
        .option("--headroom <fraction>", "PSU headroom over the peak draw (default 0.3)", parseNumberArg)
        .action(async (parts: string[], flags: { headroom?: number }, command: Command) => {
            await runOperation(command, "pc_build_check", {
                parts: parts.map(parsePcPart),
                psu_headroom: flags.headroom,
            });
        });
    pc.command("suggest")
        .description("Suggest a compatible build within a CZK budget from live listings (slow: about a minute)")
        .argument("<budget>", "Total budget in CZK", parseIntArg)
        .option("--profile [profile]", `Budget split: ${PC_SUGGEST_PROFILES.join(", ")} (default gaming)`)
        .option("--cpu [vendor]", `CPU vendor: ${PC_CPU_VENDORS.join(", ")}`)
        .option("--fixed <part>", "A part you already chose (code[:role]); repeatable", collect)
        .option("--skip <role>", `A role to leave out (${PC_ROLES.join(", ")}); repeatable`, collect)
        .option("--max-fetches <n>", "Upper bound on product reads", parseIntArg)
        .option("--headroom <fraction>", "PSU headroom over the peak draw (default 0.3)", parseNumberArg)
        .action(async (budget: number, flags: SuggestFlags, command: Command) => {
            const profile = await pickEnumFlag({
                tool: TOOL,
                subcommand: ["pc", "suggest"],
                flag: "--profile",
                given: flags.profile,
                values: PC_SUGGEST_PROFILES,
                fallback: "gaming",
                accepts: (v): v is (typeof PC_SUGGEST_PROFILES)[number] =>
                    (PC_SUGGEST_PROFILES as readonly string[]).includes(v),
            });
            if (!profile) {
                return;
            }

            const cpuVendor =
                flags.cpu === undefined
                    ? undefined
                    : await pickEnumFlag({
                          tool: TOOL,
                          subcommand: ["pc", "suggest"],
                          flag: "--cpu",
                          given: flags.cpu,
                          values: PC_CPU_VENDORS,
                          fallback: "amd",
                          accepts: (v): v is (typeof PC_CPU_VENDORS)[number] =>
                              (PC_CPU_VENDORS as readonly string[]).includes(v),
                      });
            if (cpuVendor === null) {
                return;
            }

            await runOperation(command, "pc_build_suggest", {
                budget,
                profile,
                cpu_vendor: cpuVendor,
                fixed_parts: flags.fixed?.map(parsePcPart),
                skip_roles: flags.skip,
                max_detail_fetches: flags.maxFetches,
                psu_headroom: flags.headroom,
            });
        });
}

function registerAccountSections(program: Command): void {
    const account = program.command("account").description("Account sections (signed in), and Alza's contacts");
    const simple: Array<[string, string, string]> = [
        ["profile", "Your profile: name, email, phone, address book (--json for all)", "profile"],
        ["contacts", "Alza's contact channels (no sign-in needed)", "contacts"],
        ["gdpr", "The GDPR section and data-export dialog (reads only)", "gdpr_info"],
        ["subscription", "Your AlzaPlus+ / subscription section", "subscription_overview"],
    ];
    for (const [name, description, operation] of simple) {
        account
            .command(name)
            .description(description)
            .action(async (_flags: unknown, command: Command) => {
                await runAccountOperation(command, operation, {});
            });
    }

    account
        .command("claims")
        .description("Your warranty claims (active, or --archive)")
        .option("--archive", "Archived claims instead of active ones")
        .action(async (flags: { archive?: boolean }, command: Command) => {
            await runAccountOperation(command, "complaint_claims", { scope: flags.archive ? "archive" : "active" });
        });
    account
        .command("claim")
        .description("One warranty claim, by its detailAction link from `account claims --json`")
        .argument("<href>", "The claim's detailAction href")
        .action(async (href: string, _flags: unknown, command: Command) => {
            await runAccountOperation(command, "claim_detail", { href });
        });
}

function registerOrderExtras(program: Command): void {
    const orders = program.commands.find((c) => c.name() === "orders");
    if (!orders) {
        throw new Error("register the account commands before the extras");
    }

    orders
        .command("search")
        .description("Search your orders by number or product; shows invoice links")
        .argument("<query...>", "Order number or product words")
        .action(async (query: string[], _flags: unknown, command: Command) => {
            await runAccountOperation(command, "order_search", { query: query.join(" ") });
        });
    orders
        .command("document")
        .description("Download an invoice or order document (an https Alza link) to a file")
        .argument("<url>", "The document link from `orders search`")
        .requiredOption("--out <path>", "File to write")
        .option("--overwrite", "Replace an existing file")
        .action(async (url: string, flags: { out: string; overwrite?: boolean }, command: Command) => {
            await runAccountOperation(command, "order_document", {
                url,
                output: flags.out,
                overwrite: flags.overwrite,
            });
        });
    orders
        .command("payments")
        .description("Payment options still open for an unpaid order part (reads only)")
        .argument("<order>", "Order number")
        .argument("<part>", "Order part number")
        .action(async (order: string, part: string, _flags: unknown, command: Command) => {
            await runAccountOperation(command, "after_order_payments", { order_id: order, part_id: part });
        });
}

function registerCheckout(program: Command): void {
    const checkout = program
        .command("checkout")
        .description("Checkout reads for the basket: delivery, payments, preview (nothing is ever ordered)");
    checkout
        .command("delivery")
        .description("Delivery options and payment methods for the basket")
        .option("--option <id>", "Anchor the listing on a delivery option id", parseIntArg)
        .action(async (flags: { option?: number }, command: Command) => {
            await runAccountOperation(command, "delivery_options", { selected_delivery_option_id: flags.option });
        });
    checkout
        .command("payments")
        .description("Payment methods for the basket")
        .option("--option <id>", "Anchor the listing on a delivery option id", parseIntArg)
        .action(async (flags: { option?: number }, command: Command) => {
            await runAccountOperation(command, "payment_methods", { selected_delivery_option_id: flags.option });
        });
    checkout
        .command("pickup")
        .description("Which payments fit one delivery option, and the resulting prices (does not pick a box)")
        .argument("<deliveryId>", "Delivery option id from `checkout delivery`", parseIntArg)
        .option("--group <id>", "Its delivery group id (found when omitted)", parseIntArg)
        .option("--place <id>", "A pickup place id", parseIntArg)
        .action(async (deliveryId: number, flags: { group?: number; place?: number }, command: Command) => {
            await runAccountOperation(command, "select_pickup_point", {
                delivery_id: deliveryId,
                delivery_group_id: flags.group,
                parcel_shop_id: flags.place,
            });
        });
    checkout
        .command("preview")
        .description(
            "Preview the checkout: lines, total, delivery and payments (runs Alza's first step, orders nothing)"
        )
        .option("--option <id>", "Preview with this delivery option id", parseIntArg)
        .action(async (flags: { option?: number }, command: Command) => {
            await runAccountOperation(command, "checkout_preview", { selected_delivery_option_id: flags.option });
        });
    checkout
        .command("address")
        .description("Look up postal codes and places")
        .argument("<query...>", "Postal code or place, e.g. 110 00 or Brno")
        .action(async (query: string[], _flags: unknown, command: Command) => {
            await runAccountOperation(command, "address_search", { query: query.join(" ") });
        });
}

export function registerExtraCommands(program: Command): void {
    registerPc(program);
    registerAccountSections(program);
    registerOrderExtras(program);
    registerCheckout(program);

    program
        .command("chat")
        .description("The live chatbot's navigation actions (reads only, sends nothing)")
        .action(async (_flags: unknown, command: Command) => {
            await runAccountOperation(command, "chat_navigation", {});
        });

    program
        .command("raw")
        .description(`Raw read-only GET of one fixed app route: ${RAW_READ_NAMES.join(", ")}`)
        .argument("<operation>", "Which read")
        .argument("[args...]", "Its arguments as key=value, e.g. product_id=9383715")
        .action(async (operation: string, args: string[], _flags: unknown, command: Command) => {
            await runAccountOperation(command, "mobile_read", { operation, args: parseRawArgs(args) });
        });
}
