/**
 * Minimal hash-based router — no react-router dependency, works with the
 * existing static index.html (no server rewrite needed) and survives the
 * cross-tab simulator scenario (opening `#/simulator` in a new tab Just Works).
 */
import { useEffect, useState } from 'react';

function current(): string {
  const h = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
  return h || '/';
}

export function useHashRoute(): string {
  const [route, setRoute] = useState<string>(current());
  useEffect(() => {
    const onChange = () => setRoute(current());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** Navigate by setting the hash (used by the "Open simulator" nav button). */
export function navigate(path: string): void {
  location.hash = path;
}
