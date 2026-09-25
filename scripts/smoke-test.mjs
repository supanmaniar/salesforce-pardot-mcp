#!/usr/bin/env node
/**
 * smoke-test.mjs — connects to the built MCP server over stdio and exercises
 * the catalog tools (no credentials required for these).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, PARDOT_DEBUG: 'false' },
  stderr: 'pipe',
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });

function show(label, res) {
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  console.log(`\n=== ${label} ===`);
  console.log(text.length > 1200 ? text.slice(0, 1200) + '\n…(truncated)' : text);
}

try {
  await client.connect(transport);
  console.log('✔ connected');

  const tools = await client.listTools();
  console.log(`✔ tools (${tools.tools.length}):`);
  for (const t of tools.tools) console.log(`   - ${t.name}`);

  const resources = await client.listResources();
  console.log(`✔ resources: ${resources.resources.map((r) => r.uri).join(', ')}`);

  const prompts = await client.listPrompts();
  console.log(`✔ prompts: ${prompts.prompts.map((p) => p.name).join(', ')}`);

  show(
    'list_endpoints(group=Prospect)',
    await client.callTool({
      name: 'pardot_list_endpoints',
      arguments: { group: 'Prospect' },
    })
  );

  show(
    'list_endpoints(search="addTag")',
    await client.callTool({
      name: 'pardot_list_endpoints',
      arguments: { search: 'addTag', limit: 5 },
    })
  );

  show(
    'describe_endpoint(prospect.create)',
    await client.callTool({
      name: 'pardot_describe_endpoint',
      arguments: { endpointId: 'prospect.create' },
    })
  );

  show(
    'describe_endpoint(bogus id) -> suggestions',
    await client.callTool({
      name: 'pardot_describe_endpoint',
      arguments: { endpointId: 'prospect.creat' },
    })
  );

  show(
    'delete blocked by safety guard',
    await client.callTool({
      name: 'pardot_delete',
      arguments: { endpointId: 'prospect.delete', pathParams: { id: 1 } },
    })
  );

  show(
    'wrong verb for endpoint',
    await client.callTool({
      name: 'pardot_query',
      arguments: { endpointId: 'prospect.create' },
    })
  );

  show(
    'missing path param',
    await client.callTool({
      name: 'pardot_read',
      arguments: { endpointId: 'prospect.read', query: { fields: 'id' } },
    })
  );

  await client.close();
  console.log('\n✔ smoke test complete');
} catch (err) {
  console.error('✘ smoke test failed:', err);
  process.exit(1);
}
