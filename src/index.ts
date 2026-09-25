#!/usr/bin/env node
/**
 * index.ts — MCP server entrypoint (stdio transport).
 *
 * Exposes the Salesforce Marketing Cloud Account Engagement (Pardot) V5 API
 * as a catalog-driven set of MCP tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig, missingCredentials, log } from './config.js';
import { TokenManager } from './auth.js';
import { PardotClient } from './client.js';
import { loadCatalog } from './catalog.js';
import { registerTools } from './tools.js';

const SERVER_NAME = 'pardot-mcp-server';
const SERVER_VERSION = '1.0.0';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const catalog = loadCatalog();

  const missing = missingCredentials(cfg);
  if (missing.length) {
    // Warn but still start: the model can browse the catalog without credentials,
    // and the error surfaces clearly on the first API call.
    console.error(
      `[${SERVER_NAME}] WARNING: missing required environment variable(s): ${missing.join(', ')}. ` +
        'Catalog browsing will work, but API calls will fail until they are set.'
    );
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const tokens = new TokenManager(cfg);
  const client = new PardotClient(cfg, tokens);

  registerTools(server, cfg, client);

  // --- Resources: expose the catalog and API metadata ----------------------
  server.registerResource(
    'endpoint-catalog',
    'pardot://catalog',
    {
      title: 'Pardot V5 endpoint catalog',
      description:
        `Full machine-readable catalog of ${catalog.stats.endpointCount} Pardot V5 API endpoints ` +
        `across ${catalog.stats.groupCount} resource groups.`,
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(catalog, null, 2),
        },
      ],
    })
  );

  server.registerResource(
    'api-overview',
    'pardot://overview',
    {
      title: 'Pardot V5 API overview',
      description: 'Authentication model, base URL, required headers, and endpoint statistics.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              api: catalog.api,
              stats: catalog.stats,
              groups: catalog.groups,
              configuration: {
                apiDomain: cfg.apiDomain,
                loginUrl: cfg.loginUrl,
                businessUnitIdConfigured: Boolean(cfg.businessUnitId),
                credentialsConfigured: missing.length === 0,
                allowDestructive: cfg.allowDestructive,
              },
            },
            null,
            2
          ),
        },
      ],
    })
  );

  // --- Prompts: guided workflows -------------------------------------------
  server.registerPrompt(
    'explore-pardot',
    {
      title: 'Explore the Pardot API',
      description: 'Guided workflow for discovering and calling Pardot endpoints.',
      argsSchema: {
        goal: z.string().describe('What you want to accomplish, e.g. "find prospects by email".'),
      },
    },
    ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\n\n` +
              'Work through these steps:\n' +
              '1. Call pardot_list_endpoints with a `search` or `group` filter to find candidate endpoints.\n' +
              '2. Call pardot_describe_endpoint on the best match to learn its required params and body schema.\n' +
              '3. Call the matching verb tool (pardot_query / pardot_read / pardot_create / ' +
              'pardot_update / pardot_delete / pardot_action).\n' +
              '4. Remember `fields` is required on most endpoints — pass a comma-separated field list.\n' +
              '5. If a call fails, read the `hint` field in the error response before retrying.',
          },
        },
      ],
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(cfg, `${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
  log(cfg, `catalog: ${catalog.stats.endpointCount} endpoints / ${catalog.stats.groupCount} groups`);
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
