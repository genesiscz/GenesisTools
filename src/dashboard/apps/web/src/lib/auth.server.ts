import { WorkOS } from '@workos-inc/node'
import { sealData } from 'iron-session'

// WorkOS client singleton
const workos = new WorkOS(process.env.WORKOS_API_KEY)

export { workos }

// Cookie configuration
export const COOKIE_NAME = 'wos-session'

// Get OAuth authorization URL for direct OAuth (bypasses AuthKit hosted page)
export function getOAuthAuthorizationUrl(
  provider: 'GoogleOAuth' | 'GitHubOAuth'
): string {
  const clientId = process.env.WORKOS_CLIENT_ID
  const redirectUri = process.env.WORKOS_REDIRECT_URI

  if (!clientId || !redirectUri) {
    throw new Error('OAuth configuration missing: WORKOS_CLIENT_ID or WORKOS_REDIRECT_URI')
  }

  return workos.userManagement.getAuthorizationUrl({
    clientId,
    redirectUri,
    provider,
  })
}

// Exchange authorization code for tokens
export async function exchangeCodeForToken(code: string) {
  const clientId = process.env.WORKOS_CLIENT_ID

  if (!clientId) {
    throw new Error('WORKOS_CLIENT_ID not configured')
  }

  const authResult = await workos.userManagement.authenticateWithCode({
    clientId,
    code,
  })

  return authResult
}

// Encrypt session data for cookie
export async function encryptSession(session: {
  accessToken: string
  refreshToken: string
  user: unknown
}): Promise<string> {
  const password = process.env.WORKOS_COOKIE_PASSWORD
  if (!password || password.length < 32) {
    throw new Error('WORKOS_COOKIE_PASSWORD must be at least 32 characters')
  }
  return await sealData(session, { password })
}
