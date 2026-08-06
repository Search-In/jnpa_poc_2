/**
 * Sign-in gate — a port of UC-3's `web/src/components/auth/LoginGate.tsx`.
 *
 * Same flow, same copy, same states (idle → busy → "Invalid credentials"), same
 * single opaque error for every failure. The MARKUP differs for one reason
 * only: UC-3's console is a Tailwind app and this one is not — UC-2 has no
 * Tailwind or PostCSS in its build, so UC-3's utility classes would render as
 * an unstyled form here. It is rebuilt with the Calcite components and theme
 * tokens UC-2 already uses everywhere else, so it looks native to this console.
 *
 * The behaviour that matters — the API call, the credentials, the token, the
 * session — is not reimplemented: it all lives in ./session.ts, which is the
 * direct port of UC-3's auth module.
 */
import { useState } from 'react';
import { CalciteButton, CalciteInput, CalciteLabel, CalciteNotice } from '@esri/calcite-components-react';
import { login } from './session.js';
import { tokens } from '../theme/tokens.js';

export function LoginGate({ onAuthed }: { onAuthed: (role: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onAuthed(await login(username, password));
    } catch {
      setErr('Invalid credentials');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: '100vh',
        padding: 24,
        background: tokens.color.bg,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: '100%',
          maxWidth: 380,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 24,
          borderRadius: 8,
          border: `1px solid ${tokens.color.border}`,
          background: tokens.color.bgPanel,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: tokens.color.text }}>
            JNPA UC-2 — Sign in
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: tokens.color.textMuted }}>
            Uses your JNPA DTCCC account — the same credentials as UC-3. Accounts are issued by your
            DTCCC administrator.
          </p>
        </div>

        <CalciteLabel scale="s">
          Username
          <CalciteInput
            value={username}
            autocomplete="username"
            required
            onCalciteInputInput={(e) => setUsername((e.target as HTMLCalciteInputElement).value ?? '')}
          />
        </CalciteLabel>

        <CalciteLabel scale="s">
          Password
          <CalciteInput
            type="password"
            value={password}
            autocomplete="current-password"
            required
            onCalciteInputInput={(e) => setPassword((e.target as HTMLCalciteInputElement).value ?? '')}
          />
        </CalciteLabel>

        {err ? (
          <CalciteNotice open kind="danger" scale="s">
            <div slot="message">{err}</div>
          </CalciteNotice>
        ) : null}

        <CalciteButton width="full" scale="m" type="submit" loading={busy || undefined} disabled={busy || undefined}>
          {busy ? 'Signing in…' : 'Sign in'}
        </CalciteButton>
      </form>
    </div>
  );
}
