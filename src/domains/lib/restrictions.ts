export type RestrictionKind = "presence" | "https" | "term" | "verification";

export interface TldRestriction {
    kind: RestrictionKind;
    note: string;
}

/**
 * Registration rules that can stop a purchase or change what the name can do. Registry policies change;
 * this is a warning list, not legal advice. Unlisted TLDs have no rule here.
 */
const RESTRICTIONS: Record<string, TldRestriction> = {
    eu: { kind: "presence", note: "registrant must be an EU/EEA citizen, resident or organisation" },
    it: { kind: "presence", note: "registrant must be in the EU/EEA" },
    fr: { kind: "presence", note: "registrant must be in the EU/EEA (AFNIC)" },
    re: { kind: "presence", note: "registrant must be in the EU/EEA (AFNIC)" },
    pm: { kind: "presence", note: "registrant must be in the EU/EEA (AFNIC)" },
    tf: { kind: "presence", note: "registrant must be in the EU/EEA (AFNIC)" },
    wf: { kind: "presence", note: "registrant must be in the EU/EEA (AFNIC)" },
    yt: { kind: "presence", note: "registrant must be in the EU/EEA (AFNIC)" },
    us: { kind: "presence", note: "US nexus required (citizen, resident or US business)" },
    ca: { kind: "presence", note: "Canadian presence required" },
    "com.au": { kind: "presence", note: "Australian presence required" },
    jp: { kind: "presence", note: "local presence in Japan required" },
    kr: { kind: "presence", note: "local presence in Korea required" },
    cn: { kind: "verification", note: "real-name verification required" },
    de: { kind: "presence", note: "a registrant outside Germany needs a German agent (many registrars provide one)" },
    ly: { kind: "presence", note: "names under 4 characters need local presence in Libya" },
    ai: { kind: "term", note: "minimum registration term is 2 years" },
    dev: { kind: "https", note: "HSTS-preloaded: the site works only over HTTPS" },
    app: { kind: "https", note: "HSTS-preloaded: the site works only over HTTPS" },
    page: { kind: "https", note: "HSTS-preloaded: the site works only over HTTPS" },
    new: { kind: "verification", note: "the site must let visitors create something (Google policy)" },
    bank: { kind: "verification", note: "verified banks only" },
    insurance: { kind: "verification", note: "verified insurers only" },
};

export function restrictionFor(tld: string): TldRestriction | undefined {
    return RESTRICTIONS[tld];
}
