#!/usr/bin/env node
/**
 * generate-catalog.mjs
 * ---------------------------------------------------------------------------
 * Converts the official Salesforce "Marketing Cloud Account Engagement API
 * (fka Pardot API)" Postman Collection (v2.1.0) into a compact, machine
 * readable endpoint catalog consumed by the MCP server at runtime.
 *
 * Usage:
 *   node scripts/generate-catalog.mjs [inputPath] [outputPath]
 *
 * Defaults:
 *   input  = ../Sources/Marketing Cloud Account Engagement API Reference.json
 *   output = ../catalog/endpoints.json
 * ---------------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const INPUT =
  process.argv[2] ??
  resolve(PROJECT_ROOT, '..', 'Sources', 'Marketing Cloud Account Engagement API Reference.json');
const OUTPUT = process.argv[3] ?? resolve(PROJECT_ROOT, 'catalog', 'endpoints.json');

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Recursively walk Postman items, yielding [pathSegments, requestItem]. */
function* walkItems(items, path = []) {
  for (const item of items ?? []) {
    if (Array.isArray(item.item)) {
      yield* walkItems(item.item, [...path, item.name]);
    } else if (item.request) {
      yield { path: [...path, item.name], item };
    }
  }
}

/** "Custom Field" -> "custom-field" */
function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "FilterByCreatedAt" -> "filter-by-created-at" */
function camelToSlug(text) {
  return slug(String(text).replace(/([a-z0-9])([A-Z])/g, '$1-$2'));
}

/**
 * Infer a JSON Schema fragment from a sample value.
 *
 * NOTE: we deliberately do NOT emit a `required` array. The Postman collection
 * only provides *sample* bodies, so every property is present in the sample --
 * marking them all required would be wrong (especially for PATCH endpoints,
 * which are partial updates by definition). The schema is therefore advisory:
 * it describes shape and types, not obligations.
 */
function inferSchema(value, depth = 0) {
  if (depth > 8) return { type: 'object' };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    if (value.length === 0) {
      // An empty sample array tells us nothing about the item shape.
      return {
        type: 'array',
        description: 'Sample array was empty; item shape not inferable from the collection.',
      };
    }
    return { type: 'array', items: inferSchema(value[0], depth + 1) };
  }
  switch (typeof value) {
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'string': {
      const schema = { type: 'string' };
      if (/^\d{4}-\d{2}-\d{2}T/.test(value)) schema.format = 'date-time';
      else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) schema.format = 'date';
      else if (/^https?:\/\//.test(value)) schema.format = 'uri';
      else if (/^\{\{.+\}\}$/.test(value)) schema.description = 'Postman variable placeholder';
      return schema;
    }
    case 'object': {
      const properties = {};
      for (const [k, v] of Object.entries(value)) {
        properties[k] = inferSchema(v, depth + 1);
      }
      return { type: 'object', properties };
    }
    default:
      return {};
  }
}

/** Parse a Postman raw body into JSON when possible. */
function parseRawBody(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Determine whether a query param is required from its description. */
function isRequiredParam(param) {
  const desc = String(param.description ?? '');
  return /\(required\)/i.test(desc) || /^\s*required\b/i.test(desc);
}

/** Classify an endpoint into a coarse "kind". */
function classify(method, path) {
  const p = path.toLowerCase();
  if (method === 'DELETE') return 'delete';
  if (method === 'PATCH' || method === 'PUT') return 'update';
  if (method === 'POST') {
    if (p.includes('/do/')) return 'action';
    if (p.includes('/exports')) return 'export';
    if (p.includes('/imports')) return 'import';
    return 'create';
  }
  if (method === 'GET') {
    return /:[a-z0-9_]+$/.test(p) ? 'read' : 'query';
  }
  return 'other';
}

/** Endpoints that mutate or destroy data in a risky way. */
function isDestructive(method, path, actionName) {
  if (method === 'DELETE') return true;
  if (method === 'POST' && /\/do\//i.test(path)) {
    return /remove|delete|cancel|undelete/i.test(actionName);
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Build catalog                                                              */
/* -------------------------------------------------------------------------- */

const collection = JSON.parse(readFileSync(INPUT, 'utf8'));

const collectionVars = Object.fromEntries(
  (collection.variable ?? []).map((v) => [v.key, v.value ?? ''])
);

const endpoints = [];
const usedIds = new Map();

for (const { path, item } of walkItems(collection.item)) {
  const req = item.request;
  const method = String(req.method ?? 'GET').toUpperCase();

  // Postman nests as: ["Version 5", "<Group>", "<Action>", ...]
  const group = path[1] ?? path[0] ?? 'General';
  const actionName = path[path.length - 1] ?? 'Request';

  // --- URL -----------------------------------------------------------------
  const url = req.url ?? {};
  const pathSegments = Array.isArray(url.path) ? url.path : [];
  const apiPath = '/' + pathSegments.join('/');

  // Path params: segments beginning with ":" plus declared url.variable entries.
  const declaredVars = new Map(
    (url.variable ?? []).map((v) => [v.key, v.description ?? ''])
  );
  const pathParams = [];
  for (const seg of pathSegments) {
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      pathParams.push({
        name,
        required: true,
        type: 'string',
        description: declaredVars.get(name) ?? `Path parameter "${name}"`,
      });
    }
  }

  // --- Query params --------------------------------------------------------
  const queryParams = (url.query ?? []).map((q) => {
    const rawDefault = q.value ?? '';
    // Postman variable placeholders ({{nextPageToken}}) are not real defaults.
    const isPlaceholder = /^\{\{.*\}\}$/.test(rawDefault);
    return {
      name: q.key,
      required: isRequiredParam(q),
      type: /^(true|false)$/i.test(String(rawDefault))
        ? 'boolean'
        : /^\d+$/.test(String(rawDefault))
          ? 'integer'
          : 'string',
      description: String(q.description ?? '').trim(),
      default: isPlaceholder ? '' : rawDefault,
      disabledInPostman: Boolean(q.disabled),
    };
  });

  // --- Body ----------------------------------------------------------------
  const body = req.body ?? {};
  const bodyMode = body.mode ?? null;
  let bodySchema = null;
  let bodySample = null;
  let formFields = null;

  if (bodyMode === 'raw') {
    const parsed = parseRawBody(body.raw);
    if (parsed !== null) {
      bodySample = parsed;
      bodySchema = inferSchema(parsed);
    } else if (typeof body.raw === 'string' && body.raw.trim()) {
      bodySchema = { type: 'string', description: 'Raw request body' };
      bodySample = body.raw;
    }
  } else if (bodyMode === 'formdata') {
    formFields = (body.formdata ?? []).map((f) => ({
      name: f.key,
      type: f.type === 'file' ? 'file' : 'string',
      required: true,
      description: String(f.description ?? '').trim(),
    }));
    bodySchema = {
      type: 'object',
      properties: Object.fromEntries(
        formFields.map((f) => [
          f.name,
          f.type === 'file'
            ? { type: 'string', format: 'binary', description: 'Absolute file path' }
            : { type: 'string' },
        ])
      ),
      required: formFields.map((f) => f.name),
    };
    // Form-data endpoints have no JSON sample; synthesize a descriptive one so
    // describe_endpoint always returns a usable example.
    bodySample = Object.fromEntries(
      formFields.map((f) => [
        f.name,
        f.type === 'file' ? '/absolute/path/to/file.csv' : '<string value>',
      ])
    );
  }

  // --- Headers -------------------------------------------------------------
  const headers = (req.header ?? [])
    .filter((h) => !h.disabled)
    .map((h) => ({ name: h.key, value: h.value ?? '' }));

  // --- Identity ------------------------------------------------------------
  const kind = classify(method, apiPath);
  let id = `${slug(group)}.${camelToSlug(actionName)}`;
  if (usedIds.has(id)) {
    const n = usedIds.get(id) + 1;
    usedIds.set(id, n);
    id = `${id}-${n}`;
  } else {
    usedIds.set(id, 0);
  }

  const description =
    String(req.description ?? '').trim() ||
    `${method} ${apiPath} — ${group} / ${actionName}`;

  endpoints.push({
    id,
    name: `${group} ${actionName}`,
    group,
    action: actionName,
    kind,
    method,
    path: apiPath,
    pathParams,
    queryParams,
    headers,
    bodyMode,
    bodySchema,
    bodySample,
    formFields,
    destructive: isDestructive(method, apiPath, actionName),
    description,
  });
}

/* -------------------------------------------------------------------------- */
/* Emit                                                                       */
/* -------------------------------------------------------------------------- */

const groups = [...new Set(endpoints.map((e) => e.group))].sort();

const catalog = {
  $schema: './catalog.schema.json',
  generatedAt: new Date().toISOString(),
  source: {
    file: INPUT.split('/').pop(),
    collectionName: collection.info?.name ?? 'Unknown',
    schema: collection.info?.schema ?? null,
    postmanId: collection.info?._postman_id ?? null,
  },
  api: {
    name: 'Marketing Cloud Account Engagement (Pardot) V5 API',
    version: 'v5',
    basePath: '/api/v5',
    defaultDomain: collectionVars.domain || 'pi.pardot.com',
    defaultLoginUrl: collectionVars.oauth_domain || 'login.salesforce.com',
    auth: {
      type: 'oauth2',
      grantType: 'client_credentials',
      scope: 'pardot_api',
      tokenPath: '/services/oauth2/token',
      note:
        'The Postman collection uses the OAuth 2.0 implicit grant, which cannot be ' +
        'used by a server. This MCP server uses the client-credentials grant instead.',
    },
    requiredHeaders: [
      {
        name: 'Pardot-Business-Unit-Id',
        description: 'Pardot Business Unit ID. Sent automatically on every request.',
      },
    ],
  },
  stats: {
    endpointCount: endpoints.length,
    groupCount: groups.length,
    byMethod: endpoints.reduce((acc, e) => {
      acc[e.method] = (acc[e.method] ?? 0) + 1;
      return acc;
    }, {}),
    byKind: endpoints.reduce((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {}),
  },
  groups,
  endpoints,
};

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`✔ Catalog written to ${OUTPUT}`);
console.log(`  endpoints : ${catalog.stats.endpointCount}`);
console.log(`  groups    : ${catalog.stats.groupCount}`);
console.log(`  by method : ${JSON.stringify(catalog.stats.byMethod)}`);
console.log(`  by kind   : ${JSON.stringify(catalog.stats.byKind)}`);
