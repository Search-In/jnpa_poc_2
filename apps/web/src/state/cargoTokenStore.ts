/**
 * Module-level holder for the current POC-3 cargo token. AppProvider updates this
 * after minting/refreshing the token, so other components can read it without
 * needing to be inside the AppContext. Used for cargo API calls that need the
 * Authorization header (e.g., live vessels from marine API on POC-3).
 */

let currentToken: string | undefined = undefined;

export const cargoTokenStore = {
  /** Get the current cargo token (undefined if not yet minted or auth is disabled). */
  getToken(): string | undefined {
    return currentToken;
  },
  /** Update the token (called by AppProvider after minting/refresh). */
  setToken(token: string | undefined): void {
    currentToken = token;
  },
};
