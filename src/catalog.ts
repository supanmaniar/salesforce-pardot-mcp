/**
 * catalog.ts — loads and queries the generated endpoint catalog.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type EndpointKind =
  | 'query'
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'action'
  | 'export'
  | 'import'
  | 'other';

export interface ParamSpec {
  name: string;
  required: boolean;
  type: string;
  description: string;
  default?: string;
  disabledInPostman?: boolean;
}

export interface FormFieldSpec {
  name: string;
  type: 'string' | 'file';
  required: boolean;
  description: string;
}

export interface Endpoint {
  id: string;
  name: string;
  group: string;
  action: string;
  kind: EndpointKind;
  method: string;
  path: string;
  pathParams: ParamSpec[];
  queryParams: ParamSpec[];
  headers: { name: string; value: string }[];
  bodyMode: 'raw' | 'formdata' | 'urlencoded' | null;
  bodySchema: Record<string, unknown> | null;
  bodySample: unknown;
  formFields: FormFieldSpec[] | null;
  destructive: boolean;
  description: string;
}

export interface Catalog {
  generatedAt: string;
  source: { file: string; collectionName: string; schema: string | null; postmanId: string | null };
  api: {
    name: string;
    version: string;
    basePath: string;
    defaultDomain: string;
    defaultLoginUrl: string;
    auth: {
      type: string;
      grantType: string;
      scope: string;
      tokenPath: string;
      note: string;
    };
    requiredHeaders: { name: string; description: string }[];
  };
  stats: {
    endpointCount: number;
    groupCount: number;
    byMethod: Record<string, number>;
    byKind: Record<string, number>;
  };
  groups: string[];
  endpoints: Endpoint[];
}

let cached: Catalog | null = null;

export function loadCatalog(): Catalog {
  if (cached) return cached;
  const catalogPath = resolve(__dirname, '..', 'catalog', 'endpoints.json');
  cached = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;
  return cached;
}

export function getEndpoint(id: string): Endpoint | undefined {
  return loadCatalog().endpoints.find((e) => e.id === id);
}

/** Case-insensitive, order-independent fuzzy match used for helpful errors. */
export function suggestEndpoints(id: string, limit = 5): string[] {
  const needle = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const scored = loadCatalog().endpoints.map((e) => {
    const hay = e.id.toLowerCase().replace(/[^a-z0-9]/g, '');
    let score = 0;
    if (hay.includes(needle) || needle.includes(hay)) score += 10;
    // shared prefix length
    let i = 0;
    while (i < hay.length && i < needle.length && hay[i] === needle[i]) i++;
    score += i;
    return { id: e.id, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.id);
}

export interface ListFilter {
  group?: string;
  kind?: string;
  method?: string;
  search?: string;
  includeDestructive?: boolean;
  limit?: number;
}

export function listEndpoints(filter: ListFilter = {}): Endpoint[] {
  const { group, kind, method, search, includeDestructive = true, limit } = filter;
  const needle = search?.toLowerCase();

  let results = loadCatalog().endpoints.filter((e) => {
    if (group && e.group.toLowerCase() !== group.toLowerCase()) return false;
    if (kind && e.kind !== kind) return false;
    if (method && e.method !== method.toUpperCase()) return false;
    if (!includeDestructive && e.destructive) return false;
    if (needle) {
      const hay = `${e.id} ${e.name} ${e.path} ${e.description}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  if (limit && limit > 0) results = results.slice(0, limit);
  return results;
}

/** Compact projection used when listing endpoints to the model. */
export function summarize(e: Endpoint) {
  return {
    id: e.id,
    method: e.method,
    path: e.path,
    name: e.name,
    kind: e.kind,
    destructive: e.destructive,
  };
}
