/**
 * client.ts — thin HTTP client for the Pardot V5 API.
 *
 * Responsibilities:
 *  - inject the bearer token and the mandatory Pardot-Business-Unit-Id header
 *  - substitute :pathParams and append query params
 *  - build JSON / form-data bodies
 *  - retry on 429 and 5xx with exponential backoff
 *  - transparently re-authenticate once on 401
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { PardotConfig } from './config.js';
import { log } from './config.js';
import type { TokenManager } from './auth.js';
import type { Endpoint } from './catalog.js';

export interface CallOptions {
  pathParams?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  /** For formdata endpoints: map of field name -> value (string or absolute file path). */
  formData?: Record<string, string>;
  /** Extra headers merged over the endpoint defaults. */
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  ok: boolean;
  contentType: string | null;
  /** Parsed JSON when the response is JSON, otherwise null. */
  data: unknown;
  /** Raw text, truncated when very large. */
  text: string;
  truncated: boolean;
  durationMs: number;
  url: string;
  method: string;
}

const MAX_TEXT_CHARS = 100_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Body type accepted by the global fetch implementation (avoids DOM lib). */
type RequestBody = NonNullable<RequestInit['body']>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class PardotClient {
  constructor(
    private readonly cfg: PardotConfig,
    private readonly tokens: TokenManager
  ) {}

  /** Build the fully-qualified URL for an endpoint + options. */
  buildUrl(endpoint: Endpoint, opts: CallOptions): string {
    let path = endpoint.path;

    // Substitute :param segments.
    for (const [key, value] of Object.entries(opts.pathParams ?? {})) {
      path = path.replace(new RegExp(`:${key}(?=/|$)`, 'g'), encodeURIComponent(String(value)));
    }

    const leftover = path.match(/:[A-Za-z0-9_]+/g);
    if (leftover) {
      throw new Error(
        `Missing required path parameter(s) for ${endpoint.id}: ${leftover.join(', ')}`
      );
    }

    const url = new URL(this.cfg.apiDomain + path);

    // Endpoint-declared query params (skip Postman placeholders / disabled ones).
    for (const qp of endpoint.queryParams) {
      if (qp.disabledInPostman) continue;
      const v = qp.default;
      if (v && !/^\{\{.*\}\}$/.test(v)) url.searchParams.set(qp.name, v);
    }

    // Caller-supplied query params override defaults.
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  /** Execute an endpoint call. */
  async call(endpoint: Endpoint, opts: CallOptions = {}): Promise<CallResult> {
    const url = this.buildUrl(endpoint, opts);
    const method = endpoint.method;

    const { body, contentType } = this.buildBody(endpoint, opts);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Pardot-Business-Unit-Id': this.cfg.businessUnitId,
    };
    if (contentType) headers['Content-Type'] = contentType;
    for (const h of endpoint.headers) {
      if (h.name.toLowerCase() === 'pardot-business-unit-id') continue;
      if (h.value && !/^\{\{.*\}\}$/.test(h.value)) headers[h.name] = h.value;
    }
    Object.assign(headers, opts.headers ?? {});

    let attempt = 0;
    let reauthed = false;
    const started = Date.now();

    for (;;) {
      attempt++;
      const token = await this.tokens.getToken();
      const res = await this.send(method, url, { ...headers, Authorization: `Bearer ${token}` }, body);

      // 401 -> refresh token once and retry immediately.
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        log(this.cfg, '401 received — refreshing access token and retrying');
        this.tokens.invalidate();
        continue;
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt <= this.cfg.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt * 500, 15_000);
        log(this.cfg, `HTTP ${res.status} — retrying in ${backoff}ms (attempt ${attempt})`);
        await sleep(backoff);
        continue;
      }

      const text = await res.text();
      const truncated = text.length > MAX_TEXT_CHARS;
      const clipped = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;
      const contentTypeHeader = res.headers.get('content-type');

      let data: unknown = null;
      if (contentTypeHeader?.includes('json') || /^\s*[[{]/.test(clipped)) {
        try {
          data = JSON.parse(clipped);
        } catch {
          data = null;
        }
      }

      return {
        status: res.status,
        ok: res.ok,
        contentType: contentTypeHeader,
        data,
        text: clipped,
        truncated,
        durationMs: Date.now() - started,
        url,
        method,
      };
    }
  }

  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: RequestBody | undefined
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    log(this.cfg, `${method} ${url}`);
    try {
      return await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Request to ${method} ${url} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private buildBody(
    endpoint: Endpoint,
    opts: CallOptions
  ): { body: RequestBody | undefined; contentType: string | undefined } {
    if (endpoint.bodyMode === 'formdata') {
      const form = new FormData();
      const fields = endpoint.formFields ?? [];
      const provided = opts.formData ?? {};

      for (const field of fields) {
        const value = provided[field.name];
        if (value === undefined) {
          if (field.required) {
            throw new Error(
              `Missing required form field "${field.name}" for ${endpoint.id}. ` +
                `Expected fields: ${fields.map((f) => f.name).join(', ')}`
            );
          }
          continue;
        }
        if (field.type === 'file') {
          const buf = readFileSync(value);
          form.append(field.name, new Blob([buf]), basename(value));
        } else {
          form.append(field.name, value);
        }
      }
      // Allow extra form fields not declared in the collection.
      for (const [k, v] of Object.entries(provided)) {
        if (!fields.some((f) => f.name === k)) form.append(k, v);
      }
      return { body: form, contentType: undefined }; // fetch sets the boundary
    }

    if (opts.body !== undefined && opts.body !== null) {
      return {
        body: JSON.stringify(opts.body),
        contentType: 'application/json',
      };
    }

    return { body: undefined, contentType: undefined };
  }
}
