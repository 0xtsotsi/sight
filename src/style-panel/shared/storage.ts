import type { AuthSession } from './auth-client'

const TOKEN_KEY = 'moden.session'

export type StoredSession = Pick<AuthSession, 'accessToken' | 'refreshToken' | 'expiresAt'> &
  Partial<Pick<AuthSession, 'user' | 'subscription'>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function hasStoredSessionDetails(session: StoredSession): session is AuthSession {
  return Boolean(
    session.user?.id &&
    typeof session.user.email === 'string' &&
    (
      session.subscription?.status === 'subscribed' ||
      session.subscription?.status === 'not-subscribed'
    ),
  )
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return null

    const accessToken = typeof parsed.accessToken === 'string' ? parsed.accessToken : ''
    const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken : ''
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : NaN
    if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) return null

    const stored: StoredSession = { accessToken, refreshToken, expiresAt }
    if (isRecord(parsed.user)) {
      const id = typeof parsed.user.id === 'string' ? parsed.user.id : ''
      const email = typeof parsed.user.email === 'string' ? parsed.user.email : ''
      if (id && email) stored.user = { id, email }
    }
    if (isRecord(parsed.subscription)) {
      const status = parsed.subscription.status
      if (status === 'subscribed' || status === 'not-subscribed') {
        stored.subscription = {
          status,
          isLegacy: parsed.subscription.isLegacy === true,
          renewalDate: typeof parsed.subscription.renewalDate === 'string' ? parsed.subscription.renewalDate : null,
        }
      }
    }

    return stored
  } catch {
    return null
  }
}

export function saveSession(session: AuthSession) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(session))
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
}
