/**
 * tools.ts — the MCP tool surface.
 *
 * Rather than exposing 238 individual tools (which would bloat the model's
 * context and hurt tool-selection accuracy), we expose a small set of generic,
 * catalog-driven tools. The model discovers endpoints with
 * `pardot_list_endpoints` / `pardot_describe_endpoint`, then invokes them
 * through the verb-specific tools below.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PardotConfig } from './config.js';
import type { PardotClient, CallResult } from './client.js';
import {
  loadCatalog,
  getEndpoint,
  listEndpoints,
  suggestEndpoints,
  summarize,
  type Endpoint,
} from './catalog.js';

/* -------------------------------------------------------------------------- */
/* Result formatting                                                          */
/* -------------------------------------------------------------------------- */

type ToolResponse = CallToolResult;

function ok(payload: unknown): ToolResponse {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function fail(message: string): ToolResponse {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Turn an HTTP result into a compact, model-friendly payload. */
function formatResult(endpoint: Endpoint, res: CallResult): ToolResponse {
  const payload: Record<string, unknown> = {
    endpoint: endpoint.id,
    request: `${res.method} ${res.url}`,
    status: res.status,
    ok: res.ok,
    durationMs: res.durationMs,
  };

  if (res.data !== null) {
    payload.data = res.data;
  } else if (res.text) {
    payload.body = res.text;
  }
  if (res.truncated) {
    payload.note = 'Response body was truncated for display.';
  }

  if (!res.ok) {
    payload.hint = hintForStatus(res.status);
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
  }

  return ok(payload);
}

function hintForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'Bad request — check required query params (notably `fields`) and body field names/types.';
    case 401:
      return 'Unauthorized — verify PARDOT_CLIENT_ID / PARDOT_CLIENT_SECRET and the pardot_api scope.';
    case 403:
      return 'Forbidden — the Connected App or user may lack access to this object, or the business unit ID is wrong.';
    case 404:
      return 'Not found — verify the record id and that the object exists in this business unit.';
    case 405:
      return 'Method not allowed for this path.';
    case 429:
      return 'Rate limited — Pardot enforces daily API call limits. Retry later or reduce call volume.';
    default:
      return status >= 500
        ? 'Server error from Pardot — safe to retry.'
        : 'Unexpected response.';
  }
}

/* -------------------------------------------------------------------------- */
/* Shared schemas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The Postman collection embeds enormous comma-separated `fields` defaults
 * (often 100+ field names). Echoing those on every describe call wastes context,
 * so we replace long defaults with a short summary.
 */
function compactParam(p: {
  name: string;
  required: boolean;
  type: string;
  description: string;
  default?: string;
  disabledInPostman?: boolean;
}) {
  const out: Record<string, unknown> = {
    name: p.name,
    required: p.required,
    type: p.type,
    description: p.description,
  };
  const def = p.default ?? '';
  if (def && !/^\{\{.*\}\}$/.test(def)) {
    if (def.length > 80) {
      const count = def.split(',').length;
      out.defaultSummary = `${count} values, e.g. ${def.split(',').slice(0, 5).join(',')},…`;
    } else {
      out.default = def;
    }
  }
  return out;
}

const endpointId = z
  .string()
  .describe(
    'Endpoint id from the catalog, e.g. "prospect.query", "campaign.read", "form.add-tag". ' +
      'Use pardot_list_endpoints to discover ids.'
  );

const pathParams = z
  .record(z.union([z.string(), z.number()]))
  .optional()
  .describe('Path parameter values, e.g. { "id": 12345 }.');

const queryParams = z
  .record(z.unknown())
  .optional()
  .describe(
    'Query string parameters. Note: `fields` is required by most Pardot V5 endpoints — ' +
      'pass a comma-separated list, e.g. { "fields": "id,email,firstName" }.'
  );

const extraHeaders = z
  .record(z.string())
  .optional()
  .describe('Additional request headers.');

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerTools(
  server: McpServer,
  cfg: PardotConfig,
  client: PardotClient
): void {
  const catalog = loadCatalog();

  /* ---------------------------------------------------------------------- */
  /* 1. pardot_list_endpoints                                               */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'pardot_list_endpoints',
    {
      title: 'List Pardot API endpoints',
      description:
        `Browse the ${catalog.stats.endpointCount} endpoints of the Marketing Cloud Account ` +
        `Engagement (Pardot) V5 API across ${catalog.stats.groupCount} resource groups. ` +
        'Use this first to discover the endpoint id you need. Filter by group, kind, method, ' +
        'or a free-text search.',
      inputSchema: {
        group: z
          .string()
          .optional()
          .describe(`Resource group, e.g. "Prospect", "Campaign", "Form". One of: ${catalog.groups.join(', ')}`),
        kind: z
          .enum(['query', 'read', 'create', 'update', 'delete', 'action', 'export', 'import', 'other'])
          .optional()
          .describe('Endpoint kind. "query" = list, "read" = get one, "action" = POST /do/ operation.'),
        method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']).optional(),
        search: z.string().optional().describe('Free-text search over id, name, path and description.'),
        includeDestructive: z
          .boolean()
          .optional()
          .describe('Include destructive endpoints (DELETE, removeTag, cancel). Default true.'),
        limit: z.number().int().positive().max(300).optional().describe('Max results (default 50).'),
      },
    },
    async ({ group, kind, method, search, includeDestructive, limit }) => {
      const results = listEndpoints({
        group,
        kind,
        method,
        search,
        includeDestructive: includeDestructive ?? true,
        limit: limit ?? 50,
      });
      return ok({
        total: results.length,
        // Only echo the group list when the caller is browsing without a filter,
        // to avoid repeating 38 group names on every call.
        ...(group || kind || method || search ? {} : { groups: catalog.groups }),
        endpoints: results.map(summarize),
      });
    }
  );

  /* ---------------------------------------------------------------------- */
  /* 2. pardot_describe_endpoint                                            */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'pardot_describe_endpoint',
    {
      title: 'Describe a Pardot API endpoint',
      description:
        'Get the full contract for one endpoint: HTTP method, path, path params, query params, ' +
        'request body JSON schema, and a sample body. Call this before invoking an endpoint.',
      inputSchema: { endpointId },
    },
    async ({ endpointId: id }) => {
      const endpoint = getEndpoint(id);
      if (!endpoint) {
        return fail(
          `Unknown endpoint id "${id}". Did you mean: ${suggestEndpoints(id).join(', ') || 'none'}? ` +
            'Use pardot_list_endpoints to browse.'
        );
      }
      return ok({
        id: endpoint.id,
        name: endpoint.name,
        group: endpoint.group,
        kind: endpoint.kind,
        method: endpoint.method,
        path: endpoint.path,
        destructive: endpoint.destructive,
        description: endpoint.description,
        pathParams: endpoint.pathParams,
        queryParams: endpoint.queryParams.map(compactParam),
        bodyMode: endpoint.bodyMode,
        bodySchema: endpoint.bodySchema,
        bodySample: endpoint.bodySample,
        formFields: endpoint.formFields,
      });
    }
  );

  /* ---------------------------------------------------------------------- */
  /* Generic invoker shared by the verb tools                               */
  /* ---------------------------------------------------------------------- */
  async function invoke(
    id: string,
    expectedKinds: Endpoint['kind'][],
    opts: {
      pathParams?: Record<string, string | number>;
      query?: Record<string, unknown>;
      body?: unknown;
      formData?: Record<string, string>;
      headers?: Record<string, string>;
    }
  ): Promise<ToolResponse> {
    const endpoint = getEndpoint(id);
    if (!endpoint) {
      return fail(
        `Unknown endpoint id "${id}". Did you mean: ${suggestEndpoints(id).join(', ') || 'none'}?`
      );
    }

    if (!expectedKinds.includes(endpoint.kind)) {
      return fail(
        `Endpoint "${id}" is of kind "${endpoint.kind}" (${endpoint.method} ${endpoint.path}), ` +
          `which is not valid for this tool. Expected one of: ${expectedKinds.join(', ')}. ` +
          'Use pardot_describe_endpoint to inspect it.'
      );
    }

    if (endpoint.destructive && !cfg.allowDestructive) {
      return fail(
        `Refusing to call destructive endpoint "${id}" (${endpoint.method} ${endpoint.path}). ` +
          'Set PARDOT_ALLOW_DESTRUCTIVE=true to enable DELETE and destructive /do/ operations.'
      );
    }

    try {
      const res = await client.call(endpoint, opts);
      return formatResult(endpoint, res);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. pardot_query — GET a collection                                     */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'pardot_query',
    {
      title: 'Query Pardot records',
      description:
        'List/filter records from a Pardot collection endpoint (GET, kind "query"). ' +
        'Remember that `fields` is required on most endpoints. Supports pagination via ' +
        '`limit` and `nextPageToken`, and filters such as `createdAtAfter`, `idGreaterThan`, `orderBy`.',
      inputSchema: { endpointId, query: queryParams, headers: extraHeaders },
    },
    async ({ endpointId: id, query, headers }) =>
      invoke(id, ['query'], { query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 4. pardot_read — GET a single record                                   */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'pardot_read',
    {
      title: 'Read a Pardot record',
      description: 'Fetch a single record by id (GET, kind "read"). Requires the `id` path parameter.',
      inputSchema: { endpointId, pathParams, query: queryParams, headers: extraHeaders },
    },
    async ({ endpointId: id, pathParams: pp, query, headers }) =>
      invoke(id, ['read'], { pathParams: pp, query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 5. pardot_create — POST a new record                                   */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'pardot_create',
    {
      title: 'Create a Pardot record',
      description:
        'Create a record (POST, kind "create"). Pass the JSON payload in `body`. ' +
        'Use pardot_describe_endpoint to see the expected body schema and sample.',
      inputSchema: { endpointId, body: z.unknown().describe('JSON request body.'), query: queryParams, headers: extraHeaders },
    },
    async ({ endpointId: id, body, query, headers }) =>
      invoke(id, ['create'], { body, query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 6. pardot_update — PATCH an existing record                            */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'pardot_update',
    {
      title: 'Update a Pardot record',
      description:
        'Update a record (PATCH, kind "update"). Requires the `id` path parameter and a partial ' +
        'JSON `body` containing only the fields to change.',
      inputSchema: {
        endpointId,
        pathParams,
        body: z.unknown().describe('Partial JSON request body.'),
        query: queryParams,
        headers: extraHeaders,
      },
    },
    async ({ endpointId: id, pathParams: pp, body, query, headers }) =>
      invoke(id, ['update'], { pathParams: pp, body, query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 7. pardot_delete — DELETE a record                                     */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'pardot_delete',
    {
      title: 'Delete a Pardot record',
      description:
        'Delete a record (DELETE, kind "delete"). Requires the `id` path parameter. ' +
        'This is destructive and is blocked unless PARDOT_ALLOW_DESTRUCTIVE=true.',
      inputSchema: { endpointId, pathParams, query: queryParams, headers: extraHeaders },
    },
    async ({ endpointId: id, pathParams: pp, query, headers }) =>
      invoke(id, ['delete'], { pathParams: pp, query, headers })
  );

  /* ---------------------------------------------------------------------- */
  /* 8. pardot_action — /do/ operations, exports, imports, uploads          */
  /* ---------------------------------------------------------------------- */
  server.registerTool(
    'pardot_action',
    {
      title: 'Run a Pardot action, export, or import',
      description:
        'Invoke a non-CRUD operation: POST /do/ actions (addTag, removeTag, undelete, ' +
        'connectSalesforceCampaign, reorderFormFields, ...), export jobs (kind "export"), ' +
        'and import jobs (kind "import"). For file-upload endpoints, pass `formData` with an ' +
        'absolute file path for the "file" field.',
      inputSchema: {
        endpointId,
        pathParams,
        body: z.unknown().optional().describe('JSON request body, when the endpoint expects one.'),
        formData: z
          .record(z.string())
          .optional()
          .describe('Form-data fields. For file fields, supply an absolute path on disk.'),
        query: queryParams,
        headers: extraHeaders,
      },
    },
    async ({ endpointId: id, pathParams: pp, body, formData, query, headers }) =>
      invoke(id, ['action', 'export', 'import'], {
        pathParams: pp,
        body,
        formData,
        query,
        headers,
      })
  );
}
