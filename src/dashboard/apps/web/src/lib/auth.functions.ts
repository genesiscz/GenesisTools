import { createServerFn } from '@tanstack/react-start'

// Server function to get direct OAuth URL (bypasses AuthKit hosted page)
export const getOAuthUrl = createServerFn({ method: 'GET' })
  .inputValidator((data: { provider: 'google' | 'github' }) => data)
  .handler(async ({ data }) => {
    // Dynamic import to prevent bundling on client
    const { WorkOS } = await import('@workos-inc/node')

    const workos = new WorkOS(process.env.WORKOS_API_KEY)

    const provider = data.provider === 'google' ? 'GoogleOAuth' : 'GitHubOAuth'

    // Get direct OAuth authorization URL
    const url = workos.userManagement.getAuthorizationUrl({
      provider,
      clientId: process.env.WORKOS_CLIENT_ID!,
      redirectUri: process.env.WORKOS_REDIRECT_URI!,
    })

    return url
  })
