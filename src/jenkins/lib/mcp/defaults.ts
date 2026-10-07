/**
 * Values a deployment may replace by shipping its own copy of this file: a pre-filled Jenkins URL for
 * the login prompt, and the name the login suggests for the API token. No URL is baked in here,
 * because a wrong default is worse than an empty prompt.
 */
export const DEFAULT_JENKINS_URL: string | undefined = undefined;

export const TOKEN_NAME = "genesis-tools";
