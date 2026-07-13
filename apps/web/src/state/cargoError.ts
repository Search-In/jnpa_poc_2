/**
 * Maps any thrown value from a cargo operation into a user-facing message.
 * A {@link CargoApiError} carries the HTTP status (401/403/404/409/400/500) and
 * already exposes a tailored `userMessage`; anything else (network failure, etc.)
 * falls back to its own message so the panel notices always say something useful.
 */
import { CargoApiError } from '@jnpa/data';

export function cargoErrorMessage(err: unknown): string {
  if (err instanceof CargoApiError) return err.userMessage;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The HTTP status when the error came from the Cargo API, else undefined. */
export function cargoErrorStatus(err: unknown): number | undefined {
  return err instanceof CargoApiError ? err.status : undefined;
}
