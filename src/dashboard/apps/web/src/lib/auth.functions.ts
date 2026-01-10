import { createServerFn } from '@tanstack/react-start'
import { setCookie } from 'vinxi/http'
import { WorkOS } from '@workos-inc/node'
import { sealData } from 'iron-session'

const COOKIE_NAME = 'wos-session'

// Server function to get OAuth URL
export const getOAuthUrl = createServerFn({ method: 'GET' })
  .inputValidator((data: { provider: 'google' | 'github' }) => data)
  .handler(async ({ data }) => {
    const workos = new WorkOS(process.env.WORKOS_API_KEY)
    const clientId = process.env.WORKOS_CLIENT_ID
    const redirectUri = process.env.WORKOS_REDIRECT_URI

    if (!clientId || !redirectUri) {
      throw new Error('OAuth configuration missing')
    }

    const provider = data.provider === 'google' ? 'GoogleOAuth' : 'GitHubOAuth'

    return workos.userManagement.getAuthorizationUrl({
      clientId,
      redirectUri,
      provider,
    })
  })

// Server function to exchange code for token and set cookie
export const handleOAuthCallback = createServerFn({ method: 'POST' })
  .inputValidator((data: { code: string }) => data)
  .handler(async ({ data }) => {
    const workos = new WorkOS(process.env.WORKOS_API_KEY)
    const clientId = process.env.WORKOS_CLIENT_ID
    const password = process.env.WORKOS_COOKIE_PASSWORD

    if (!clientId) {
      throw new Error('WORKOS_CLIENT_ID not configured')
    }
    if (!password || password.length < 32) {
      throw new Error('WORKOS_COOKIE_PASSWORD must be at least 32 characters')
    }

    const authResult = await workos.userManagement.authenticateWithCode({
      clientId,
      code: data.code,
    })

    // Encrypt session
    const encryptedSession = await sealData({
      accessToken: authResult.accessToken,
      refreshToken: authResult.refreshToken,
      user: authResult.user,
    }, { password })

    // Set cookie
    setCookie(COOKIE_NAME, encryptedSession, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    })

    return { success: true, user: authResult.user }
  })
