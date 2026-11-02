// Adapted from lukabudik/alza-mcp-community (MIT) — src/domain/pc-build-service.ts
/**
 * PC builder orchestration (issue #15): fetches real Alza products and runs
 * the pure rules from `pc-build.ts` over them.
 *
 * - `check`: an agent-chosen parts list → one detail fetch per part (cached
 *   15 min by `Catalog`), role detection, rule verdicts.
 * - `suggest`: a budget → for each role in dependency order, one category
 *   listing page (the real component category, `/{categoryId}.htm`), a
 *   name-based pre-filter (chipset → socket, DDR type, PSU wattage), then
 *   bounded detail fetches until a candidate passes the rules that apply to
 *   that role given the parts already chosen.
 *
 * Detail fetches are budgeted (`maxDetailFetches`) and reported back. Here a detail is one JSON product read and
 * a listing is one server-rendered category page, both through the Chrome-fingerprint client.
 */
import {
    allocateBudget,
    type BuildParts,
    type BuildProfile,
    backtrackCaps,
    checkBuild,
    checkForcedRole,
    detectRole,
    estimatePower,
    MULTI_ROLES,
    type NormalizedSpecs,
    nonComponentReason,
    normalizeSpecs,
    type OverallVerdict,
    overallVerdict,
    PC_CATEGORY_IDS,
    type PcRole,
    type PowerEstimate,
    type ProductParam,
    RAM_CATEGORY_BY_TYPE,
    REQUIRED_BUILD_ROLES,
    type RulePart,
    type RuleVerdict,
    rankCandidates,
    rulesForCandidate,
    SUGGEST_ORDER,
    socketHintFromBoardName,
    wattageHintFromName,
} from "./pc-build";

/** A product as the builder reads it: a listing card (no params) or a detail (with the spec rows). */
export interface Product {
    code: string;
    name: string;
    url: string;
    price?: number;
    currency?: string;
    availability?: string;
    /** Alza's own purchasable flag; wins over the availability text. */
    inStock?: boolean;
    params?: ProductParam[];
}

/** The three catalog reads the builder needs. `alzaPcCatalog` (pc-build-catalog.ts) implements it over AlzaApi. */
export interface PcCatalog {
    getProductSpecs(code: string): Promise<Product>;
    searchProducts(opts: {
        categoryId: number;
        inStock: boolean;
        limit: number;
        producerIds?: number[];
    }): Promise<{ products: Product[] }>;
    getCategoryFilters(categoryId: number): Promise<{ brands: Array<{ description: string; valueId: number }> }>;
}

export interface BuildPartOut {
    role: PcRole;
    code: string;
    name: string;
    url: string;
    price?: number;
    currency: string;
    /** Raw availability (schema.org value from the product page, or the card CTA). */
    availability?: string;
    /** true = purchasable now, false = not, null = undetermined. */
    inStock: boolean | null;
    /** Normalised specs the rules used, each with its Czech source row. */
    specs: NormalizedSpecs;
    /** false when the part was chosen from its listing card only (no detail fetch). */
    specsFetched: boolean;
    /** Where this part came from in `pc_build_suggest`: "fixed" (user-pinned) or "suggested". */
    origin?: "fixed" | "suggested";
}

export interface BuildReport {
    parts: BuildPartOut[];
    total: number;
    currency: string;
    /** Codes of parts without a known price (excluded from `total`). */
    unpriced: string[];
    /** true when `total` leaves out unpriced parts, so it understates the real cost. */
    totalIncomplete: boolean;
    /** Required roles (cpu, motherboard, ram, psu, case) the build lacks; non-empty means no "compatible" verdict. */
    missingRoles: PcRole[];
    verdicts: RuleVerdict[];
    overall: OverallVerdict;
    powerEstimate?: PowerEstimate;
    notes: string[];
    /** Product detail page loads this call requested (cache hits included). */
    detailFetches: number;
    /** Category listing page loads (suggest only). */
    categoryPages: number;
    budget?: number;
    /**
     * suggest only: true when the total fits the budget, false when it is over even without the unpriced parts, null
     * when a part has no price, so the real total and the fit are unknown.
     */
    withinBudget?: boolean | null;
    profile?: BuildProfile;
    allocation?: Partial<Record<PcRole, number>>;
}

export interface CheckInput {
    parts: Array<{ code: string; role?: PcRole }>;
    psuHeadroom?: number;
}

export interface SuggestInput {
    budget: number;
    profile?: BuildProfile;
    cpuVendor?: "amd" | "intel";
    fixedParts?: Array<{ code: string; role?: PcRole }>;
    skipRoles?: PcRole[];
    maxDetailFetches?: number;
    psuHeadroom?: number;
}

const DEFAULT_CURRENCY = "CZK";
export const DEFAULT_MAX_DETAIL_FETCHES = 14;
export const MAX_DETAIL_FETCHES = 24;
export const MAX_CHECK_PARTS = 10;
/** Detail fetches tried per role before giving up on that role. */
const TRIES_PER_ROLE = 3;
/** Listing cards considered per role (one category page). */
const CARDS_PER_ROLE = 24;

export function inStockFrom(availability: string | undefined): boolean | null {
    if (!availability) {
        return null;
    }
    if (/^(InStock|in stock)$/i.test(availability)) {
        return true;
    }
    if (/out ?of ?stock|not purchasable|sold ?out|discontinued|pre ?order|back ?order|on order/i.test(availability)) {
        return false;
    }
    return null;
}

/** A usable price: Alza's product pages report a Discontinued / unavailable offer as 0, which is "no price", not a free part. */
function usablePrice(price: number | undefined): number | undefined {
    return price !== undefined && Number.isFinite(price) && price > 0 ? price : undefined;
}

function toPart(role: PcRole, p: Product, specsFetched: boolean, origin?: "fixed" | "suggested"): BuildPartOut {
    return {
        role,
        code: p.code,
        name: p.name,
        url: p.url,
        price: usablePrice(p.price),
        currency: p.currency?.trim() || DEFAULT_CURRENCY,
        availability: p.availability,
        inStock: p.inStock ?? inStockFrom(p.availability),
        specs: specsFetched ? normalizeSpecs(role, p.params) : {},
        specsFetched,
        origin,
    };
}

function toBuildParts(parts: BuildPartOut[]): BuildParts {
    const b: BuildParts = {};
    for (const p of parts) {
        const rp: RulePart = { code: p.code, name: p.name, specs: p.specs };
        if (p.role === "ram" || p.role === "storage") {
            const list = b[p.role] ?? [];
            list.push(rp);
            b[p.role] = list;
        } else {
            b[p.role] = rp;
        }
    }
    return b;
}

function summarize(parts: BuildPartOut[], verdicts: RuleVerdict[], psuHeadroom: number | undefined) {
    const priced = parts.filter((p) => p.price !== undefined);
    const total = priced.reduce((s, p) => s + (p.price ?? 0), 0);
    const b = toBuildParts(parts);
    const powerEstimate = b.cpu || b.gpu ? estimatePower(b, psuHeadroom) : undefined;
    const missingRoles = REQUIRED_BUILD_ROLES.filter((r) => !parts.some((p) => p.role === r));
    const unpriced = parts.filter((p) => p.price === undefined).map((p) => p.code);
    return {
        total,
        currency: parts.find((p) => p.currency)?.currency ?? DEFAULT_CURRENCY,
        unpriced,
        totalIncomplete: unpriced.length > 0,
        missingRoles,
        overall: overallVerdict(verdicts, { complete: missingRoles.length === 0 }),
        powerEstimate,
    };
}

function assertDistinctCodes(codes: string[]): void {
    const dup = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dup) {
        throw new Error(`product code ${dup} is listed twice — list each part once`);
    }
}

/**
 * The role of a part the user named (a `check` part or a `suggest` fixed part): an explicit role must fit the spec
 * table (a laptop is refused as a CPU), and without one the role is detected. `label` prefixes the messages.
 */
function resolvePartRole(
    req: { code: string; role?: PcRole },
    product: Product,
    warnings: string[],
    label: string
): PcRole {
    if (req.role) {
        const c = checkForcedRole(req.role, product.name, product.params);
        if (c.error) {
            throw new Error(`${label}${req.code}: ${c.error}`);
        }

        if (c.warning) {
            warnings.push(`${label}${req.code}: ${c.warning}`);
        }

        return req.role;
    }

    const role = detectRole(product.name, product.params);
    if (!role) {
        const device = nonComponentReason(product.params);
        const why = device
            ? `— ${device}`
            : product.params?.length
              ? "from its specs"
              : "— its product page returned no spec table";
        throw new Error(
            `Could not tell which component ${label}${req.code} ("${product.name}") is ${why}. Pass its role explicitly (cpu, motherboard, ram, gpu, storage, case, cooler, psu).`
        );
    }

    return role;
}

export class PcBuilder {
    constructor(private readonly catalog: PcCatalog) {}

    async check(input: CheckInput): Promise<BuildReport> {
        const codes = input.parts.map((p) => p.code.trim());
        if (codes.length === 0) {
            throw new Error("parts must contain at least one product code");
        }
        if (codes.length > MAX_CHECK_PARTS) {
            throw new Error(`at most ${MAX_CHECK_PARTS} parts per check (each is a product page load)`);
        }
        assertDistinctCodes(codes);

        const parts: BuildPartOut[] = [];
        const roleWarnings: string[] = [];
        let detailFetches = 0;
        for (const req of input.parts) {
            const product = await this.catalog.getProductSpecs(req.code.trim());
            detailFetches++;
            const role = resolvePartRole(req, product, roleWarnings, "");
            parts.push(toPart(role, product, true));
        }
        const specless = parts.filter((p) => p.role !== "storage" && Object.keys(p.specs).length === 0);
        assertSingleRoles(parts);
        const verdicts = checkBuild(toBuildParts(parts), { psuHeadroom: input.psuHeadroom });
        const notes: string[] = [];
        const missingRoles = REQUIRED_BUILD_ROLES.filter((r) => !parts.some((p) => p.role === r));
        if (missingRoles.length) {
            notes.push(
                `Not a complete build — no ${missingRoles.join(", ")}; rules needing them are not_applicable, so "no_conflicts_found" is not a "compatible" verdict.`
            );
        }
        notes.push(...roleWarnings);
        if (specless.length) {
            notes.push(
                `No usable spec rows found for ${specless.map((p) => p.code).join(", ")} — their rules are unknown; retry later or check the product page.`
            );
        }
        notes.push(...advisoryNotes(parts));
        const oos = parts.filter((p) => p.inStock === false);
        if (oos.length) {
            notes.push(`Not purchasable right now: ${oos.map((p) => p.code).join(", ")}.`);
        }
        return {
            parts,
            verdicts,
            notes,
            detailFetches,
            categoryPages: 0,
            ...summarize(parts, verdicts, input.psuHeadroom),
        };
    }

    async suggest(input: SuggestInput): Promise<BuildReport> {
        const profile = input.profile ?? "gaming";
        const maxFetches = Math.min(
            MAX_DETAIL_FETCHES,
            Math.max(1, input.maxDetailFetches ?? DEFAULT_MAX_DETAIL_FETCHES)
        );
        const notes: string[] = [];
        let detailFetches = 0;
        let categoryPages = 0;
        const parts: BuildPartOut[] = [];

        // 1. User-pinned parts first: they constrain everything else. Each is one product read of the same budget,
        // and gets the role checks `check` applies.
        const fixedParts = input.fixedParts ?? [];
        assertDistinctCodes(fixedParts.map((p) => p.code.trim()));
        if (fixedParts.length > maxFetches) {
            throw new Error(
                `${fixedParts.length} fixed parts need ${fixedParts.length} product reads, more than the detail-fetch budget (${maxFetches}); raise it or pin fewer parts.`
            );
        }
        for (const req of fixedParts) {
            const product = await this.catalog.getProductSpecs(req.code.trim());
            detailFetches++;
            const role = resolvePartRole(req, product, notes, "fixed part ");
            parts.push(toPart(role, product, true, "fixed"));
        }
        assertSingleRoles(parts);

        const skip = new Set(input.skipRoles ?? []);
        const fixedRoles = new Set(parts.map((p) => p.role));
        const roles = SUGGEST_ORDER.filter(
            (r) => !skip.has(r) && !fixedRoles.has(r) && (profile !== "office" || r !== "gpu")
        );
        if (profile === "office" && !skip.has("gpu") && !fixedRoles.has("gpu")) {
            notes.push(
                "Office profile: no graphics card — the CPU must have integrated graphics (display_output rule)."
            );
        }
        const fixedSpend = parts.reduce((s, p) => s + (p.price ?? 0), 0);
        const allocation = allocateBudget(input.budget, profile, roles, fixedSpend);
        if (fixedSpend >= input.budget) {
            notes.push(`Fixed parts already cost ${fixedSpend} — over the ${input.budget} budget.`);
        }
        const plannedGpu = roles.includes("gpu") || fixedRoles.has("gpu");

        let carry = 0;
        const listingCache = new Map<string, Awaited<ReturnType<PcCatalog["searchProducts"]>>>();
        // Backtracking state: per-role price ceilings for a retry, and the distinct
        // listing prices seen per role (the "cheaper choices" a retry can take).
        const priceCaps: Partial<Record<PcRole, number>> = {};
        const priceLevels: Partial<Record<PcRole, number[]>> = {};
        const pickRole = async (role: PcRole): Promise<void> => {
            const target = Math.max(0, (allocation[role] ?? 0) + carry);
            const built = toBuildParts(parts);
            const categoryId = role === "ram" ? ramCategory(built) : PC_CATEGORY_IDS[role];
            // CPU vendor → the category's real brand facet (list_category_filters'
            // `brands`, which Alza honours as a URL filter in every category).
            let producerIds: number[] | undefined;
            if (role === "cpu" && input.cpuVendor) {
                const facets = await this.catalog.getCategoryFilters(categoryId);
                categoryPages++;
                const brand = facets.brands.find((b) => b.description.trim().toLowerCase() === input.cpuVendor);
                if (brand) {
                    producerIds = [brand.valueId];
                } else {
                    notes.push(
                        `cpu: brand "${input.cpuVendor}" not among category ${categoryId}'s brand facets — filtered by name instead.`
                    );
                }
            }
            const listingKey = `${categoryId}:${(producerIds ?? []).join(",")}`;
            let listing = listingCache.get(listingKey);
            if (!listing) {
                listing = await this.catalog.searchProducts({
                    categoryId,
                    inStock: true,
                    limit: CARDS_PER_ROLE,
                    producerIds,
                });
                categoryPages++;
                listingCache.set(listingKey, listing);
            }
            const cards = listing.products.filter((p) => p.price !== undefined && prefilter(role, p, built, input));
            priceLevels[role] = [...new Set(cards.map((c) => c.price!))].sort((a, b) => b - a);
            if (cards.length === 0) {
                notes.push(
                    `${role}: no in-stock candidate on the first listing page of category ${categoryId} after filtering — left empty.`
                );
                return;
            }
            // Most expensive card within the allocation first (best part the money
            // buys); for RAM, multi-module kits first (dual channel). The budget is
            // a hard limit: a card may exceed its allocation, but never the money
            // left after earlier picks minus half the later roles' allocations.
            const spent = parts.reduce((sum, p) => sum + (p.price ?? 0), 0);
            const reserve = roles
                .slice(roles.indexOf(role) + 1)
                .reduce((sum, r) => sum + Math.floor((allocation[r] ?? 0) / 2), 0);
            const hardCap = Math.min(Math.max(0, input.budget - spent - reserve), priceCaps[role] ?? Infinity);
            const ordered = rankCandidates(role, cards, Math.min(target, hardCap), hardCap);
            if (ordered.length === 0) {
                notes.push(
                    `${role}: every candidate on the first listing page costs more than the ${hardCap} left in the ${input.budget} budget — left empty (cannot fit the budget).`
                );
                return;
            }

            let chosen: BuildPartOut | undefined;
            if (role === "storage") {
                // No compatibility rule depends on storage specs — save the page load.
                chosen = toPart(role, ordered[0]!, false, "suggested");
            } else {
                const ruleIds = rulesForCandidate(role, fixedRoles).filter(
                    (r) => !(r === "display_output" && plannedGpu)
                );
                // Detail fetches still needed by the roles after this one (storage needs none).
                const laterRoles = roles.slice(roles.indexOf(role) + 1).filter((r) => r !== "storage").length;
                let fallback: BuildPartOut | undefined; // no fail, but a warn/unknown — used if no clean pass turns up
                // Cards whose specs failed a rule here: the budget fallback below must never pick one of them.
                const rejected = new Set<string>();
                let tries = 0;
                const psuLater = role !== "psu" && roles.slice(roles.indexOf(role) + 1).includes("psu");
                for (const card of ordered) {
                    if (tries >= TRIES_PER_ROLE) {
                        break;
                    }
                    if (detailFetches >= maxFetches) {
                        break;
                    }
                    // Keep one detail fetch for the PSU: it is the last role and the
                    // wattage rule needs its specs.
                    if (psuLater && tries >= 1 && maxFetches - detailFetches <= 1) {
                        break;
                    }
                    // Keep looking past a warn only while the budget still covers the later roles.
                    if (fallback && maxFetches - detailFetches <= laterRoles) {
                        break;
                    }
                    detailFetches++;
                    tries++;
                    let product: Product;
                    try {
                        product = await this.catalog.getProductSpecs(card.code);
                    } catch (e) {
                        // One candidate's page failing (timeout, delisted, CF hiccup) must
                        // not abort a multi-minute suggest run — skip it like a failed rule.
                        notes.push(
                            `${role}: skipped ${card.code} (product page failed: ${e instanceof Error ? e.message : String(e)}).`
                        );
                        continue;
                    }
                    const candidate = toPart(role, product, true, "suggested");
                    // The listing card may be stale: the product page is the authority on stock and price.
                    if (candidate.inStock === false) {
                        notes.push(`${role}: skipped ${card.code} (its product page says it cannot be bought now).`);
                        rejected.add(card.code);
                        continue;
                    }

                    if (candidate.price === undefined) {
                        candidate.price = card.price;
                    } else if (candidate.price > hardCap) {
                        notes.push(
                            `${role}: skipped ${card.code} (its product page price ${candidate.price} is above the ${hardCap} left in the budget).`
                        );
                        rejected.add(card.code);
                        continue;
                    }

                    const relevant = checkBuild(toBuildParts([...parts, candidate]), {
                        psuHeadroom: input.psuHeadroom,
                    }).filter((v) => ruleIds.includes(v.rule));
                    if (role === "psu") {
                        const w = candidate.specs.psuWattage?.value;
                        const need = estimatePower(built, input.psuHeadroom).recommendedPsuW;
                        if (w !== undefined && w < need) {
                            notes.push(`psu: skipped ${card.code} (${w} W is below the recommended ${need} W).`);
                            rejected.add(card.code);
                            continue;
                        }
                    }
                    const failing = relevant.filter((v) => v.verdict === "fail");
                    if (failing.length > 0) {
                        notes.push(`${role}: skipped ${card.code} (${failing.map((f) => f.rule).join(", ")} failed).`);
                        rejected.add(card.code);
                        continue;
                    }
                    const doubtful = relevant
                        .filter((v) => v.verdict === "warn" || v.verdict === "unknown")
                        .map((v) => `${v.rule}=${v.verdict}`);
                    if (role === "ram" && candidate.specs.memoryModules?.value === 1) {
                        doubtful.push("single_channel");
                    }
                    if (doubtful.length === 0) {
                        chosen = candidate;
                        break;
                    }
                    if (!fallback) {
                        fallback = candidate;
                        notes.push(`${role}: ${card.code} only got ${doubtful.join(", ")} — looking for a clean pass.`);
                    }
                }
                if (!chosen && fallback) {
                    chosen = fallback;
                    notes.push(`${role}: kept ${fallback.code} (no candidate passed cleanly within the tries/budget).`);
                } else if (!chosen && detailFetches >= maxFetches) {
                    const unrejected = ordered.find((c) => !rejected.has(c.code));
                    if (unrejected) {
                        chosen = toPart(role, unrejected, false, "suggested");
                        notes.push(
                            `${role}: detail-fetch budget (${maxFetches}) exhausted — ${chosen.code} picked from its listing card without specs; its rules are unknown. Re-run pc_build_check on the final list.`
                        );
                    } else {
                        notes.push(
                            `${role}: detail-fetch budget (${maxFetches}) exhausted and every candidate read failed a rule — left empty; pin a part via fixed_parts.`
                        );
                    }
                } else if (!chosen) {
                    notes.push(
                        `${role}: none of the first ${TRIES_PER_ROLE} candidates passed ${ruleIds.join(", ")} — left empty; pin a part via fixed_parts.`
                    );
                }
            }
            if (chosen) {
                parts.push(chosen);
                carry = target - (chosen.price ?? 0);
            }
        };

        const carryBefore = new Map<PcRole, number>();
        for (const role of SUGGEST_ORDER) {
            if (!roles.includes(role)) {
                continue;
            }
            carryBefore.set(role, carry);
            await pickRole(role);
        }

        // 3. Backtracking: a role is still empty although the budget is a hard cap —
        // the earlier picks (gpu, cpu) may have taken money a later role needed.
        // Retry with cheaper choices for them, bounded and deterministic; keep the
        // retry only when it yields a complete build within budget.
        const unfilled = () => roles.filter((r) => !parts.some((p) => p.role === r));
        if (unfilled().length > 0) {
            const missing = unfilled();
            const suggestedRoles = (["gpu", "cpu"] as PcRole[]).filter(
                (r) => roles.includes(r) && parts.some((p) => p.role === r && p.origin === "suggested")
            );
            const levels: Partial<Record<PcRole, number[]>> = {};
            for (const r of suggestedRoles) {
                const price = parts.find((p) => p.role === r)!.price ?? Infinity;
                levels[r] = (priceLevels[r] ?? []).filter((x) => x < price);
            }
            const attempts = backtrackCaps(levels);
            const snapshot = { parts: [...parts], notes: [...notes], carry };
            let tried = 0;
            let solved = false;
            for (const caps of attempts) {
                if (detailFetches >= maxFetches) {
                    break;
                }
                tried++;
                for (const r of Object.keys(priceCaps) as PcRole[]) {
                    delete priceCaps[r];
                }
                Object.assign(priceCaps, caps);
                const firstIdx = Math.min(...(Object.keys(caps) as PcRole[]).map((r) => roles.indexOf(r)));
                const redo = roles.slice(firstIdx);
                const attemptNotes = notes.length;
                for (const r of redo) {
                    for (let i = parts.length - 1; i >= 0; i--) {
                        if (parts[i]!.role === r && parts[i]!.origin === "suggested") {
                            parts.splice(i, 1);
                        }
                    }
                }
                carry = carryBefore.get(redo[0]!) ?? 0;
                for (const r of redo) {
                    await pickRole(r);
                }
                const total = parts.reduce((sum, p) => sum + (p.price ?? 0), 0);
                if (unfilled().length === 0 && total <= input.budget) {
                    solved = true;
                    notes.splice(
                        0,
                        notes.length,
                        ...notes.filter((n) => !missing.some((m) => n.startsWith(`${m}:`) && /left empty/.test(n)))
                    );
                    notes.push(
                        `Backtracking: ${missing.join(", ")} could not be filled with the first picks, so cheaper choices were taken for ${Object.keys(caps).join(", ")} (${tried} combination${tried === 1 ? "" : "s"} tried).`
                    );
                    break;
                }
                notes.length = attemptNotes;
                parts.splice(0, parts.length, ...snapshot.parts);
                carry = snapshot.carry;
            }
            if (!solved) {
                for (const r of Object.keys(priceCaps) as PcRole[]) {
                    delete priceCaps[r];
                }
                parts.splice(0, parts.length, ...snapshot.parts);
                notes.splice(0, notes.length, ...snapshot.notes);
                if (attempts.length === 0) {
                    notes.push(
                        `Backtracking: no cheaper gpu/cpu choice available to free budget for ${missing.join(", ")}.`
                    );
                } else {
                    notes.push(
                        `Backtracking: tried ${tried} cheaper-choice combination(s) for ${suggestedRoles.join("/")} — none completes the build (${missing.join(", ")}) within the ${input.budget} budget.`
                    );
                }
            }
        }

        const verdicts = checkBuild(toBuildParts(parts), { psuHeadroom: input.psuHeadroom });
        const s = summarize(parts, verdicts, input.psuHeadroom);
        notes.push(...advisoryNotes(parts));
        if (s.total > input.budget) {
            notes.push(`Total ${s.total} exceeds the ${input.budget} budget by ${s.total - input.budget}.`);
        } else if (s.totalIncomplete) {
            notes.push(
                `Budget fit unknown: the total ${s.total} leaves out the unpriced part(s) ${s.unpriced.join(", ")}.`
            );
        }
        const ordered = SUGGEST_ORDER.flatMap((r) => parts.filter((p) => p.role === r));
        return {
            parts: ordered,
            verdicts,
            notes,
            detailFetches,
            categoryPages,
            budget: input.budget,
            withinBudget: s.total > input.budget ? false : s.totalIncomplete ? null : true,
            profile,
            allocation,
            ...s,
        };
    }
}

/** Non-compatibility advice worth surfacing (performance, not fit). */
export function advisoryNotes(parts: BuildPartOut[]): string[] {
    const notes: string[] = [];
    const unpriced = parts.filter((p) => p.price === undefined);
    if (unpriced.length) {
        notes.push(
            `Total excludes ${unpriced.length} unpriced part(s) (no usable offer on the product page): ${unpriced.map((p) => p.code).join(", ")}.`
        );
    }
    const ram = parts.filter((p) => p.role === "ram");
    const modules = ram.reduce((s, p) => s + (p.specs.memoryModules?.value ?? 0), 0);
    if (ram.length > 0 && modules === 1) {
        notes.push("RAM is a single module — runs single-channel; a 2-module kit is noticeably faster.");
    }
    return notes;
}

function assertSingleRoles(parts: BuildPartOut[]): void {
    const seen = new Map<PcRole, string>();
    for (const p of parts) {
        if (MULTI_ROLES.has(p.role)) {
            continue;
        }
        const prev = seen.get(p.role);
        if (prev) {
            throw new Error(
                `Two parts have role ${p.role} (${prev}, ${p.code}) — a build takes one; only ram and storage may repeat.`
            );
        }
        seen.set(p.role, p.code);
    }
}

function ramCategory(b: BuildParts): number {
    const types = b.motherboard?.specs.memoryTypes?.value ?? b.cpu?.specs.memoryTypes?.value ?? ["DDR5"];
    const t = types.includes("DDR5") ? "DDR5" : types.includes("DDR4") ? "DDR4" : "DDR5";
    return RAM_CATEGORY_BY_TYPE[t] ?? PC_CATEGORY_IDS.ram;
}

/**
 * Name-based pre-filter on listing cards — cheap, avoids detail fetches of
 * obviously wrong candidates. It never accepts on its own: the detail fetch
 * + rules decide.
 */
export function prefilter(
    role: PcRole,
    card: Product,
    built: BuildParts,
    input: Pick<SuggestInput, "cpuVendor" | "psuHeadroom">
): boolean {
    const name = card.name;
    switch (role) {
        case "cpu":
            if (input.cpuVendor === "amd" && !/\bAMD\b|Ryzen/i.test(name)) {
                return false;
            }
            if (input.cpuVendor === "intel" && !/\bIntel\b|Core/i.test(name)) {
                return false;
            }
            return true;
        case "motherboard": {
            const want = built.cpu?.specs.socket?.value;
            const hint = socketHintFromBoardName(name);
            return !want || !hint || hint === want;
        }
        case "ram": {
            if (/SO-?DIMM|notebook/i.test(name)) {
                return false;
            }
            const types = built.motherboard?.specs.memoryTypes?.value ?? built.cpu?.specs.memoryTypes?.value;
            return !types || types.some((t) => new RegExp(`\\b${t}\\b`, "i").test(name));
        }
        case "psu": {
            const hint = wattageHintFromName(name);
            if (hint === undefined) {
                return true;
            }
            return hint >= estimatePower(built, input.psuHeadroom).recommendedPsuW;
        }
        default:
            return true;
    }
}
