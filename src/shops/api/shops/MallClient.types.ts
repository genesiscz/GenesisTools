// Discriminated union: keeps `tld` and `currency` paired so impossible
// combinations (e.g. `tld: "cz"` with `currency: "EUR"`) are unrepresentable.
export type MallCountryConfig = { tld: "cz"; currency: "CZK" } | { tld: "sk"; currency: "EUR" };
