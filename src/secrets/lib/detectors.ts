import { shannonEntropy } from "./entropy";
import { isPlaceholderSecret } from "./placeholders";
import type { Detector } from "./types";

// Secret-ish identifier prefixes. Bare `key` is deliberately excluded: it is
// overwhelmingly object-property / cache-key noise (`{ key: "daysOnMarket" }`,
// `CACHE_KEY = "..."`). Real credentials are named api[_-]key, secretKey,
// accessKey, privateKey, token, password, auth — all still covered below.
const ASSIGN = `(?:secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key|auth)`;

// The dotenv detector reads whole `KEY=value` lines, where `AUTHOR_NAME` or `AUTHORITY_HOST`
// are ordinary settings: there `auth` must not run straight into another letter.
const DOTENV_ASSIGN = ASSIGN.replace("|auth)", "|auth(?![a-z]))");

// A URL without `user:pass@` and a filesystem path are configuration, not credentials, unless
// the URL's query string carries one under a credential-like name (`?token=…`, `&api_key=…`).
const URL_WITHOUT_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*(?:[/?#][^@]*)?$/i;
const CREDENTIAL_QUERY_PARAM = new RegExp(`[?&][A-Za-z0-9_]*${DOTENV_ASSIGN}[A-Za-z0-9_]*=[^&#]{12,}`, "i");
const FILESYSTEM_PATH = /^(?:\/|\.{1,2}\/|~\/)/;

function isPlainConfigUrl(value: string): boolean {
    return URL_WITHOUT_CREDENTIALS.test(value) && !CREDENTIAL_QUERY_PARAM.test(value);
}

export const DETECTORS: Detector[] = [
    {
        name: "aws-access-key-id",
        regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
        name: "private-key",
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    },
    {
        name: "slack-token",
        regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    },
    {
        name: "github-token",
        regex: /\bgh[posr]_[0-9A-Za-z]{36,}\b/g,
    },
    {
        name: "github-fine-grained",
        regex: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/g,
    },
    {
        name: "jwt",
        regex: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/g,
    },
    {
        // Classic keys (sk-/sk-proj-/sk-svcacct-/sk-admin-…T3BlbkFJ…) carry a fixed
        // marker; the newer project keys drop the marker but run 100+ chars.
        name: "openai-key",
        regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b|\bsk-proj-[A-Za-z0-9_-]{100,}\b/g,
    },
    {
        name: "anthropic-key",
        regex: /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{80,}\b/g,
    },
    {
        name: "stripe-key",
        regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    },
    {
        name: "openrouter-key",
        regex: /\bsk-or-v1-[a-f0-9]{64}\b/g,
    },
    {
        name: "google-api-key",
        regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    },
    {
        // identifier containing a secret-ish word, assigned to a single quoted
        // token (no whitespace — real credentials never contain spaces)
        name: "generic-assignment",
        regex: new RegExp(`${ASSIGN}["'\`]?\\s*[:=]\\s*["'\`]([^"'\`\\n\\s]{12,})["'\`]`, "gi"),
        secretGroup: 1,
        accept: (secret) => !isPlaceholderSecret(secret),
    },
    {
        // dotenv shape: `KEY=value` (optionally `export KEY=value`), unquoted, to end
        // of line (a trailing ` #comment` excluded). Anchored so the ASSIGN word has
        // to sit in the one identifier token right after `^`/`export `, and `=` takes no
        // spaces: `const token = getToken()` and `password = settings.DB_PASSWORD` are code.
        // The trailing comment is only looked ahead at, never matched: scanContent finds the
        // value's column by searching the match, and a comment repeating the value would
        // otherwise win that search and leave the real value unmasked in the preview.
        name: "dotenv-assignment",
        regex: new RegExp(
            `^(?:export\\s+)?[A-Za-z0-9_]*${DOTENV_ASSIGN}[A-Za-z0-9_]*=([^\\s"'\`#()]{12,})(?=\\s*(?:#.*)?$)`,
            "gi"
        ),
        secretGroup: 1,
        accept: (secret) => !isPlaceholderSecret(secret) && !isPlainConfigUrl(secret) && !FILESYSTEM_PATH.test(secret),
    },
    {
        // assignment to a long base64-ish blob; gated by entropy in `accept`
        name: "high-entropy-base64",
        regex: new RegExp(`${ASSIGN}["'\`]?\\s*[:=]\\s*["'\`]([A-Za-z0-9+/=_-]{20,})["'\`]`, "gi"),
        secretGroup: 1,
        accept: (secret, config) => {
            if (config.disableEntropy || isPlaceholderSecret(secret)) {
                return false;
            }

            return shannonEntropy(secret) >= config.entropyThreshold;
        },
    },
];
