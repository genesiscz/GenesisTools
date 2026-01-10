import { createServerFn } from '@tanstack/react-start'

// Server function to get sign-in URL
// Note: This goes to hosted AuthKit page - for direct OAuth, WorkOS connection settings must be configured
export const getOAuthUrl = createServerFn({ method: 'GET' })
  .inputValidator((data: { provider: 'google' | 'github' }) => data)
  .handler(async ({ data }) => {
    // Dynamic import to prevent bundling on client
    const { getSignInUrl } = await import('@workos/authkit-tanstack-react-start')

    // Get sign-in URL - the provider hint is handled by WorkOS dashboard connection settings
    const url = await getSignInUrl({
      data: { returnPathname: '/dashboard' },
    })

    return url
  })
