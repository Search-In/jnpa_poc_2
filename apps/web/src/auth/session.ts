/**
 * Session handling for the UC-2 console — a port of UC-3's `web/src/lib/auth.ts`.
 *
 * This is deliberately the SAME contract as UC-3, not a parallel one:
 *   • the same endpoint      POST /api/auth/login, GET /api/auth/me
 *   • the same credentials   core.app_user (admin / operator / gate / transport)
 *   • the same storage keys  jnpa_uc3_*  — so a browser signed into UC-3 on the
 *     same origin is already signed into UC-2, and signing out of one signs out
 *     of both
 *   • the same 8 h HS256 JWT, presented as `Authorization: Bearer …`
 *
 * Only the base URL differs. UC-3's console calls `/api/...` directly; UC-2
 * reaches the same gateway through its own `/poc3` proxy (see CARGO_API_BASE in
 * state/AppContext.tsx and the dev proxy in vite.config.ts), which rewrites the
 * prefix away. Both therefore hit `POST /api/auth/login` on the one gateway.
 *
 * Roles are intentionally NOT re-declared here. UC-2 already has its own `Role`
 * union for tab visibility (state/AppContext.tsx); the gateway role string is
 * kept verbatim as the session role and mapped by the caller if it needs to be.
 */

/** Base for the UC-3 auth surface. Mirrors CARGO_API_BASE so both go to the
 *  same gateway; kept local so this module has no import cycle with AppContext. */
const AUTH_BASE = ((import.meta.env?.VITE_CARGO_API_BASE as string | undefined) || '/poc3').replace(/\/$/, '');

// Same key names as UC-3 — see the module note above.
const TOKEN_KEY = 'jnpa_uc3_token';
const ROLE_KEY = 'jnpa_uc3_role';
const USER_KEY = 'jnpa_uc3_user';
const PWD_CHANGE_KEY = 'jnpa_uc3_must_change_password';

/**
 * Master switch, same variable and semantics as UC-3's console.
 * Unset/false = no sign-in step, which keeps the credential-free mock demo
 * working exactly as it does today. Deployed builds set it to "true".
 */
export function authEnabled(): boolean {
  return import.meta.env?.VITE_AUTH_ENABLED === 'true';
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRole(): string | null {
  try {
    return localStorage.getItem(ROLE_KEY);
  } catch {
    return null;
  }
}

/** The signed-in account name, for display in the header. */
export function getUsername(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}

export function setSession(token: string, role: string, username?: string | null, needsPasswordChange = false): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, role);
    if (username) localStorage.setItem(USER_KEY, username);
    localStorage.setItem(PWD_CHANGE_KEY, needsPasswordChange ? 'true' : 'false');
  } catch {
    /* storage unavailable; session is in-memory only for this load */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(PWD_CHANGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Sign out. The JWT is stateless so this is a client-side action — the gateway
 * cannot revoke an issued token (8 h TTL). Server-side revocation is UC-3's
 * `POST /api/users/{username}/disable`, which fails the next verifySession().
 * Full reload, as in UC-3: it tears down every adapter and poll opened under
 * the previous identity's token.
 */
export function logout(): void {
  clearSession();
  try {
    window.location.assign('/');
  } catch {
    /* non-browser environment (unit tests) */
  }
}

/** Sign in against the UC-3 gateway and store the resulting session.
 *
 *  The gateway answers one opaque 401 for every failure (unknown user, wrong
 *  password, disabled account), so there is deliberately nothing here that
 *  could be used to tell those cases apart. */
export async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${AUTH_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('invalid credentials');
  const data = (await res.json()) as {
    access_token: string;
    role: string;
    username?: string;
    must_change_password?: boolean;
  };
  setSession(data.access_token, data.role, data.username ?? username, Boolean(data.must_change_password));
  return data.role;
}

export interface SessionInfo {
  username: string;
  role: string;
  full_name?: string | null;
  must_change_password?: boolean;
}

/** Validate the stored session against the gateway. Returns the live identity,
 *  or null when the token is expired/invalid or the account has been disabled.
 *  Without it the console would keep rendering with an expired token, every
 *  panel erroring and no route back to the sign-in screen. */
export async function verifySession(): Promise<SessionInfo | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${AUTH_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = (await res.json()) as SessionInfo;
    if (!data?.role) return null;
    setSession(token, data.role, data.username, Boolean(data.must_change_password));
    return data;
  } catch {
    // A network failure is not proof the session is bad — keep it and let the
    // normal request path surface the outage. Only when there is no stored role
    // is there nothing worth preserving.
    const role = getRole();
    return role ? { username: getUsername() ?? '', role } : null;
  }
}
