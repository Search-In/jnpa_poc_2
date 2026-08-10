/**
 * Route protection — the port of UC-3's whole-app gate (`web/src/App.tsx:61-79`).
 *
 * UC-3 wraps a React Router tree; UC-2 has no route table (a two-branch hash
 * router, then Calcite tabs inside one root), so the equivalent choke point is
 * the root component. Same three states as UC-3: verify the stored session on
 * mount, show the gate when there is no valid one, otherwise render the app.
 *
 * When VITE_AUTH_ENABLED is not "true" this renders children untouched, so the
 * credential-free mock demo behaves exactly as it does today.
 */
import { useEffect, useState } from 'react';
import { authEnabled, clearSession, getRole, verifySession } from './session.js';
import { LoginGate } from './LoginGate.js';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState<string | null>(() => (authEnabled() ? getRole() : 'anonymous'));
  const [checking, setChecking] = useState(authEnabled());

  useEffect(() => {
    if (!authEnabled()) return;
    let alive = true;
    void (async () => {
      const session = await verifySession();
      if (!alive) return;
      if (!session) {
        clearSession();
        setRole(null);
      } else {
        setRole(session.role);
      }
      setChecking(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!authEnabled()) return <>{children}</>;
  // Hold the first paint until the stored token has been checked, so a signed-in
  // reload does not flash the login form.
  if (checking) return null;
  if (!role) return <LoginGate onAuthed={setRole} />;
  return <>{children}</>;
}
