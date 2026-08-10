/**
 * Field-terminal credential handling.
 *
 * `collabd` prints this page's credential on its own stdout as a URL fragment. A fragment is never
 * sent to the server, never lands in an access log, and never leaks through a Referer header, so
 * the human's control surface is not something an unauthenticated request can obtain. The token is
 * separate from the one the `collab` CLI uses: this page renders agent-authored Markdown, and it
 * should not be holding the credential that drives the whole operation registry.
 */

const STORAGE_KEY = 'scrapgrid.field-terminal-credential'
const FRAGMENT_KEY = 't'

export const CREDENTIAL_HINT =
  'This field terminal needs the credential collabd printed when it started. Open the "field terminal" URL from the collabd terminal — it ends with #t=…'

export class UnauthorizedError extends Error {
  constructor(message = CREDENTIAL_HINT) {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

let credential: string | null = null

function takeCredentialFromFragment(): string | null {
  const hash = window.location.hash
  if (!hash.startsWith('#')) return null
  const token = new URLSearchParams(hash.slice(1)).get(FRAGMENT_KEY)
  if (!token) return null
  // Drop it from the address bar immediately so it is not left in view or in history.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  return token
}

function bootstrapCredential(): void {
  const fromFragment = takeCredentialFromFragment()
  if (fromFragment) {
    window.sessionStorage.setItem(STORAGE_KEY, fromFragment)
    credential = fromFragment
    return
  }
  credential = window.sessionStorage.getItem(STORAGE_KEY)
}

bootstrapCredential()

export function hasCredential(): boolean {
  return credential !== null
}

export function clearCredential(): void {
  credential = null
  window.sessionStorage.removeItem(STORAGE_KEY)
}

/** Every `/api` request carries the credential; a rejected one is discarded rather than retried. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (credential === null) throw new UnauthorizedError()
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${credential}`)
  const response = await fetch(path, { ...init, headers })
  if (response.status === 401) {
    clearCredential()
    throw new UnauthorizedError(`${CREDENTIAL_HINT} (collabd rotates it on every restart.)`)
  }
  return response
}
