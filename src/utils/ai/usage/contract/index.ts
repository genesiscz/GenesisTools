/**
 * The contract every `tools ai usage` door shares (design 2026-11-01, sections 5 and 6): the
 * window grammar, the account selector, the provider list and the JSON envelope. A CLI verb, an
 * HTTP route and an MCP tool parse through here, so their flags and shapes cannot drift apart.
 */
export {
    type AccountKey,
    accountKeysOf,
    type UsageEnvelope,
    type UsageEnvelopeInput,
    type UsageSchema,
    type UsageWarning,
    type UsageWindow,
    usageEnvelope,
    usageSchema,
} from "./envelope";
export { UsageQueryError, type UsageQueryErrorCode, type UsageQueryErrorDetails } from "./errors";
export { addReservedHarnessOption, addWindowOptions } from "./options";
export { refuseHarness, resolveProviderList } from "./providers";
export {
    describeAccount,
    type SelectAccountsOptions,
    SPEND_PSEUDO_ACCOUNTS,
    selectAccounts,
    splitList,
} from "./selector";
export {
    autoSeriesStepMs,
    parseDurationMs,
    parseStep,
    resolveStepMs,
    SERIES_MAX_POINTS,
    type SeriesStep,
} from "./step";
export {
    parseWhen,
    type ResolvedWindow,
    resolveTimeZone,
    resolveWindow,
    type WindowContext,
    type WindowFlags,
} from "./window";
