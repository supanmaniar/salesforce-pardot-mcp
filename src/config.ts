/**
 * config.ts — environment-driven configuration.
 */

export interface PardotConfig {
  clientId: string;
  clientSecret: string;
  businessUnitId: string;
  loginUrl: string;
  apiDomain: string;
  timeoutMs: number;
  maxRetries: number;
  allowDestructive: boolean;
  debug: boolean;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Strip a trailing slash so we can safely join paths. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(): PardotConfig {
  return {
    clientId: env('PARDOT_CLIENT_ID') ?? '',
    clientSecret: env('PARDOT_CLIENT_SECRET') ?? '',
    businessUnitId: env('PARDOT_BUSINESS_UNIT_ID') ?? '',
    loginUrl: trimSlash(env('PARDOT_LOGIN_URL') ?? 'https://login.salesforce.com'),
    apiDomain: trimSlash(env('PARDOT_API_DOMAIN') ?? 'https://pi.pardot.com'),
    timeoutMs: envInt('PARDOT_TIMEOUT_MS', 60_000),
    maxRetries: envInt('PARDOT_MAX_RETRIES', 3),
    allowDestructive: envBool('PARDOT_ALLOW_DESTRUCTIVE', false),
    debug: envBool('PARDOT_DEBUG', false),
  };
}

/** Names of required env vars that are missing (empty array == fully configured). */
export function missingCredentials(cfg: PardotConfig): string[] {
  const missing: string[] = [];
  if (!cfg.clientId) missing.push('PARDOT_CLIENT_ID');
  if (!cfg.clientSecret) missing.push('PARDOT_CLIENT_SECRET');
  if (!cfg.businessUnitId) missing.push('PARDOT_BUSINESS_UNIT_ID');
  return missing;
}

export function log(cfg: PardotConfig, ...args: unknown[]): void {
  if (cfg.debug) console.error('[pardot-mcp]', ...args);
}
