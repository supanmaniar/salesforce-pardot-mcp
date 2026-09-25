/**
 * auth.ts — OAuth 2.0 client-credentials token manager.
 *
 * Salesforce issues short-lived access tokens (typically ~2h). We cache the
 * token in memory and refresh it shortly before expiry, and also force a
 * refresh once if the API returns 401.
 */

import type { PardotConfig } from './config.js';
import { log } from './config.js';

interface TokenResponse {
  access_token: string;
  instance_url?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/** Refresh this many ms before the real expiry to avoid edge-of-expiry 401s. */
const EXPIRY_SKEW_MS = 60_000;

export class TokenManager {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly cfg: PardotConfig) {}

  /** Returns a valid access token, fetching one if necessary. */
  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.accessToken;
    }
    // De-duplicate concurrent refreshes.
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchToken()
      .then((token) => {
        this.inflight = null;
        return token;
      })
      .catch((err) => {
        this.inflight = null;
        throw err;
      });

    return this.inflight;
  }

  /** Drops the cached token so the next call re-authenticates. */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    const url = `${this.cfg.loginUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });

    log(this.cfg, `POST ${url} (grant_type=client_credentials)`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`OAuth token request failed (network): ${reason}`);
    }
    clearTimeout(timer);

    const text = await res.text();
    let json: TokenResponse;
    try {
      json = JSON.parse(text) as TokenResponse;
    } catch {
      throw new Error(
        `OAuth token endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`
      );
    }

    if (!res.ok || json.error || !json.access_token) {
      const detail = json.error_description ?? json.error ?? text.slice(0, 300);
      throw new Error(
        `OAuth token request failed (HTTP ${res.status}): ${detail}. ` +
          'Verify PARDOT_CLIENT_ID / PARDOT_CLIENT_SECRET and that the Connected App ' +
          'has the "pardot_api" scope enabled.'
      );
    }

    const ttlMs = (json.expires_in ?? 3600) * 1000;
    this.cached = {
      accessToken: json.access_token,
      expiresAt: Date.now() + Math.max(ttlMs - EXPIRY_SKEW_MS, 30_000),
    };

    log(this.cfg, `OAuth token acquired (expires_in=${json.expires_in ?? 'unknown'}s)`);
    return json.access_token;
  }
}
