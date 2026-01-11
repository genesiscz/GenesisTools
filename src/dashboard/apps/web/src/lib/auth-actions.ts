import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { workos, encryptSession } from './auth-server'

// Error response type
export type AuthError = {
  code: string
  message: string
  email?: string
  pendingAuthenticationToken?: string
}

// Sign in schema
const signInSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

// Sign up schema
const signUpSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name is required').optional(),
  lastName: z.string().min(1, 'Last name is required').optional(),
})

// Email verification schema
const verifyEmailSchema = z.object({
  code: z.string().min(6, 'Please enter the 6-digit code'),
  pendingAuthenticationToken: z.string().min(1, 'Token is required'),
})

// Handle WorkOS errors
function handleWorkOSError(error: unknown, email?: string): AuthError {
  console.log('WorkOS Error:', JSON.stringify(error, null, 2))

  // Check for email verification required via rawData
  if (
    error &&
    typeof error === 'object' &&
    'rawData' in error &&
    error.rawData &&
    typeof error.rawData === 'object'
  ) {
    const rawData = error.rawData as {
      code?: string
      error?: string
      message?: string
      email?: string
      pending_authentication_token?: string
    }

    // Check for email verification
    if (
      rawData.code === 'email_verification_required' ||
      (rawData.error?.toLowerCase().includes('email') &&
        rawData.error?.toLowerCase().includes('verified'))
    ) {
      return {
        code: 'email_verification_required',
        message: rawData.message || rawData.error || 'Email verification required',
        email: rawData.email || email,
        pendingAuthenticationToken: rawData.pending_authentication_token,
      }
    }

    return {
      code: rawData.code || 'auth_error',
      message: rawData.message || rawData.error || 'Authentication error',
      email: rawData.email,
      pendingAuthenticationToken: rawData.pending_authentication_token,
    }
  }

  // Check for standard error with message
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message: string }).message
    if (msg.toLowerCase().includes('email') && msg.toLowerCase().includes('verified')) {
      return {
        code: 'email_verification_required',
        message: msg,
        email: email,
      }
    }
    return {
      code: 'unknown',
      message: msg,
    }
  }

  return {
    code: 'unknown',
    message: 'An unexpected error occurred',
  }
}

// Sign in with email and password
export const signInFn = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => {
    const parsed = signInSchema.safeParse(data)
    if (!parsed.success) {
      return {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Validation failed',
      }
    }
    return parsed.data
  })
  .handler(async ({ data }) => {
    if (data.code) {
      // Validation error was returned
      return data as AuthError
    }

    const clientId = process.env.WORKOS_CLIENT_ID
    if (!clientId) {
      return { code: 'config_error', message: 'Client ID not configured' }
    }

    const { email, password } = data as z.infer<typeof signInSchema>

    try {
      const authResult = await workos.userManagement.authenticateWithPassword({
        clientId,
        email,
        password,
      })

      // Encrypt and return session (to be set as cookie on client)
      const encryptedSession = await encryptSession(authResult)
      return {
        success: true,
        session: encryptedSession,
        user: authResult.user,
      }
    } catch (error) {
      return handleWorkOSError(error, email)
    }
  })

// Sign up with email and password
export const signUpFn = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => {
    const parsed = signUpSchema.safeParse(data)
    if (!parsed.success) {
      return {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Validation failed',
      }
    }
    return parsed.data
  })
  .handler(async ({ data }) => {
    if (data.code) {
      // Validation error was returned
      return data as AuthError
    }

    const clientId = process.env.WORKOS_CLIENT_ID
    if (!clientId) {
      return { code: 'config_error', message: 'Client ID not configured' }
    }

    const { email, password, firstName, lastName } = data as z.infer<typeof signUpSchema>

    try {
      // Create the user
      await workos.userManagement.createUser({
        email,
        password,
        firstName,
        lastName,
      })

      // Authenticate immediately after creation
      const authResult = await workos.userManagement.authenticateWithPassword({
        clientId,
        email,
        password,
      })

      // Encrypt and return session
      const encryptedSession = await encryptSession(authResult)
      return {
        success: true,
        session: encryptedSession,
        user: authResult.user,
      }
    } catch (error) {
      return handleWorkOSError(error, email)
    }
  })

// Verify email with code
export const verifyEmailFn = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => {
    const parsed = verifyEmailSchema.safeParse(data)
    if (!parsed.success) {
      return {
        code: 'validation_error',
        message: parsed.error.issues[0]?.message || 'Validation failed',
      }
    }
    return parsed.data
  })
  .handler(async ({ data }) => {
    if (data.code) {
      // Validation error was returned
      return data as AuthError
    }

    const clientId = process.env.WORKOS_CLIENT_ID
    if (!clientId) {
      return { code: 'config_error', message: 'Client ID not configured' }
    }

    const { code, pendingAuthenticationToken } = data as z.infer<typeof verifyEmailSchema>

    try {
      const authResult = await workos.userManagement.authenticateWithEmailVerification({
        clientId,
        code,
        pendingAuthenticationToken,
      })

      // Encrypt and return session
      const encryptedSession = await encryptSession(authResult)
      return {
        success: true,
        session: encryptedSession,
        user: authResult.user,
      }
    } catch (error) {
      return handleWorkOSError(error)
    }
  })

// Get OAuth sign-in URL
export const getOAuthUrlFn = createServerFn({ method: 'GET' })
  .inputValidator((data: { provider: 'GoogleOAuth' | 'GitHubOAuth' }) => data)
  .handler(async ({ data }) => {
    const clientId = process.env.WORKOS_CLIENT_ID
    const redirectUri = process.env.WORKOS_REDIRECT_URI

    if (!clientId || !redirectUri) {
      throw new Error('OAuth configuration missing')
    }

    const authorizationUrl = workos.userManagement.getAuthorizationUrl({
      clientId,
      redirectUri,
      provider: data.provider,
    })

    return authorizationUrl
  })
