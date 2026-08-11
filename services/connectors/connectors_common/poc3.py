"""POC-3 replay client — the connectors' live tier (ticket UC2-041).

WHY THIS EXISTS
---------------
UC2-041 is "the LIVE→CACHED→SYNTHETIC drill", and before this module the middle
tier was **unreachable in every configuration the stack can boot in**.

`FallbackChain` fills its cache in exactly one place: inside the LIVE branch, on
a successful live poll. No connector has a live poll that succeeds — all six
raise `SourceUnavailable` by design, and ULIP says why in its own words: *"We
never pretend to have live data in the PoC."* That is the correct instinct and it
is kept. But it means the cache is never written, so CACHED is never served.
Measured across every configuration the stack can run in::

    DATA_MODE=mock (how compose runs it)   -> ['SYNTHETIC'] * 5
    DATA_MODE=live, no creds               -> ['SYNTHETIC'] * 5
    DATA_MODE=live + creds set             -> ['SYNTHETIC'] * 5

A drill on that would have shown SYNTHETIC, SYNTHETIC, SYNTHETIC.

WHAT THIS IS, AND WHAT IT IS NOT
--------------------------------
This is a **second** live upstream, added beside each connector's real one — it
never replaces it. `UlipConnector.live_poll` still tries the goulip.in gateway
first and still fails honestly when the NDA token is absent; ICEGATE still wants
its Class-3 DSC. Those stubs document the real integration plan (WS3) and are a
scored deliverable, so they stay exactly as they are.

What this adds is an upstream that genuinely answers today: the POC-3 gateway,
holding the ingested UC-II corpus. A connector polling it is making a real
authenticated HTTP call to a real service and getting real rows back — which is
what makes LIVE a truthful badge and, more importantly, makes CACHED reachable:
stop POC-3 and the next poll replays the last real payload with its true age.

⚠ It is NOT the source's own production API, and the health card must never
imply it is. Every tier records **which** upstream served (`HealthCard.upstream`)
and the dashboard shows it, so "LIVE via POC-3 replay" can never be read as
"ULIP answered".

CONTRACT (gateway/routers/auth.py, gateway/routers/*.py on POC-3)
    POST /api/auth/login  {username, password} -> {access_token, role, ...}
    GET  <path>?<params>  Bearer <token>       -> [...] or {items: [...], total}

CONFIGURATION — absent by default, so nothing changes for a cold checkout
    POC3_BASE_URL   e.g. https://traffic-three.searchintech.in
    POC3_TOKEN      a pre-issued JWT, OR
    POC3_USER / POC3_PASS   a core.app_user account

With none of these set every call raises SourceUnavailable and the connectors
behave exactly as they do today. There are no credentials in this file and no
default that could stand in for one.
"""
from __future__ import annotations

import os
from typing import Any, Optional

import httpx

from .fallback import SourceUnavailable

#: Rows a single replay poll will emit. Small on purpose — a poll is a heartbeat,
#: not a bulk export, and an evaluator watching /published should see a readable
#: handful rather than a wall.
DEFAULT_LIMIT = 25


class Poc3Client:
    """Authenticated reader for one POC-3 gateway.

    One instance per connector. Holds the JWT between polls and re-mints it once
    on a 401, so an 8-hour token expiring mid-demo self-heals instead of
    surfacing as an outage that isn't one.
    """

    def __init__(
        self,
        base_url: str = "",
        token: str = "",
        username: str = "",
        password: str = "",
        timeout_s: float = 6.0,
    ) -> None:
        self.base_url = (base_url or os.environ.get("POC3_BASE_URL", "")).rstrip("/")
        self._static_token = token or os.environ.get("POC3_TOKEN", "")
        self._username = username or os.environ.get("POC3_USER", "")
        self._password = password or os.environ.get("POC3_PASS", "")
        self.timeout_s = timeout_s
        self._token: Optional[str] = self._static_token or None

    # -- identity -------------------------------------------------------------
    @property
    def configured(self) -> bool:
        """True when this client has somewhere to call and something to call with."""
        return bool(self.base_url) and bool(self._static_token or (self._username and self._password))

    def label(self) -> str:
        """Human name for the upstream, for the health card. Never a credential."""
        host = self.base_url.split("://")[-1].split("/")[0] or "unconfigured"
        return f"POC-3 replay ({host})"

    def _login(self) -> str:
        if self._static_token:
            return self._static_token
        if not (self._username and self._password):
            raise SourceUnavailable("POC-3: no POC3_TOKEN and no POC3_USER/POC3_PASS")
        try:
            res = httpx.post(
                f"{self.base_url}/api/auth/login",
                json={"username": self._username, "password": self._password},
                timeout=self.timeout_s,
            )
        except httpx.HTTPError as exc:
            raise SourceUnavailable(f"POC-3: login unreachable ({exc.__class__.__name__})") from exc
        if res.status_code != 200:
            # The gateway answers one opaque 401 for every credential failure, so
            # there is deliberately nothing here that distinguishes them either.
            raise SourceUnavailable(f"POC-3: login rejected (HTTP {res.status_code})")
        token = (res.json() or {}).get("access_token")
        if not token:
            raise SourceUnavailable("POC-3: login returned no access_token")
        self._token = str(token)
        return self._token

    # -- reads ----------------------------------------------------------------
    def rows(self, path: str, params: Optional[dict[str, Any]] = None) -> list[dict]:
        """GET one page and return its rows.

        Raises SourceUnavailable — never returns a partial or invented result —
        on anything that is not a usable page: unconfigured, unreachable,
        rejected, non-JSON, or a body that is neither a list nor `{items: [...]}`.
        An EMPTY page is also unavailable: a connector that emits nothing has not
        demonstrated a live tier, and silently badging LIVE off a zero-row reply
        is exactly the kind of unverifiable claim this ticket exists to remove.
        """
        if not self.configured:
            raise SourceUnavailable(
                "POC-3 replay: set POC3_BASE_URL + (POC3_TOKEN or POC3_USER/POC3_PASS)"
            )
        body = self._get_json(path, params or {})
        if isinstance(body, dict):
            body = body.get("items", [])
        if not isinstance(body, list):
            raise SourceUnavailable(f"POC-3: {path} returned {type(body).__name__}, not a page")
        rows = [r for r in body if isinstance(r, dict)]
        if not rows:
            raise SourceUnavailable(f"POC-3: {path} returned no rows")
        return rows

    def _get_json(self, path: str, params: dict[str, Any]) -> Any:
        token = self._token or self._login()
        for attempt in (1, 2):
            try:
                res = httpx.get(
                    f"{self.base_url}{path}",
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=self.timeout_s,
                )
            except httpx.HTTPError as exc:
                raise SourceUnavailable(f"POC-3: {path} unreachable ({exc.__class__.__name__})") from exc
            # An 8 h token expiring mid-demo is not an outage. Re-mint once and
            # retry; a second 401 is a real credential problem and falls through.
            if res.status_code == 401 and attempt == 1 and not self._static_token:
                self._token = None
                token = self._login()
                continue
            if res.status_code != 200:
                raise SourceUnavailable(f"POC-3: {path} returned HTTP {res.status_code}")
            try:
                return res.json()
            except ValueError as exc:
                raise SourceUnavailable(f"POC-3: {path} returned non-JSON") from exc
        raise SourceUnavailable(f"POC-3: {path} still 401 after re-authenticating")
