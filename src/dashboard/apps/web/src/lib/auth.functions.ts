import { createServerFn } from '@tanstack/react-start'

// Server function to get direct OAuth URL (bypasses AuthKit hosted page)
export const getOAuthUrl = createServerFn({ method: 'GET' })
  .inputValidator((data: { provider: 'google' | 'github' }) => data)
  .handler(async ({ data }) => {
    const provider = data.provider === 'google' ? 'GoogleOAuth' : 'GitHubOAuth'
    const clientId = process.env.WORKOS_CLIENT_ID
    const redirectUri = process.env.WORKOS_REDIRECT_URI

    if (!clientId || !redirectUri) {
      throw new Error('Missing WorkOS configuration')
    }

    // Construct the OAuth authorization URL
    // WorkOS OAuth endpoint for direct provider authorization
    const params = new URLSearchParams({
      client_id: clientId,
      provider: provider.toLowerCase(),
      redirect_uri: redirectUri,
      response_type: 'code',
    })

    return `https://api.workos.com/oauth/authorize?${params.toString()}`
  })
