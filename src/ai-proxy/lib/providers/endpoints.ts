/**
 * Upstream base URLs that a provider's class and its model list both read. They live here, not in the class module,
 * so a model list (and the definition table that reaches it) does not load the provider implementation.
 */
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
