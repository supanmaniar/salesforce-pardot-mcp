# Pardot MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the **Salesforce Marketing Cloud Account Engagement (Pardot) V5 API** to LLM clients such as GitHub Copilot, Claude Desktop, and Cursor.

The endpoint catalog is **generated directly from the official Salesforce Postman collection**, so all **238 endpoints across 38 resource groups** are available.

---

## Why a catalog-driven design?

Exposing 238 individual MCP tools would flood the model's context window and degrade tool-selection accuracy. Instead this server exposes **8 generic tools** plus a browsable catalog:

| Tool | Purpose |
|---|---|
| `pardot_list_endpoints` | Discover endpoints — filter by group, kind, method, or free-text search |
| `pardot_describe_endpoint` | Get the full contract: path/query params, body JSON schema, sample body |
| `pardot_query` | `GET` a collection (list/filter records) |
| `pardot_read` | `GET` a single record by id |
| `pardot_create` | `POST` a new record |
| `pardot_update` | `PATCH` an existing record |
| `pardot_delete` | `DELETE` a record *(guarded)* |
| `pardot_action` | `/do/` actions, exports, imports, file uploads |

The model's workflow is: **list → describe → invoke**.

Two MCP **resources** (`pardot://catalog`, `pardot://overview`) and one **prompt** (`explore-pardot`) are also provided.

---

## Quick start

### 1. Install and build

```bash
cd pardot-mcp-server
npm install
npm run build
```

That's it — the endpoint catalog is **already committed** at `catalog/endpoints.json`, so no extra step is needed to get running.

> **Regenerating the catalog is optional.** It's only necessary if you want to rebuild it from the source Postman collection, which is not included in this repository (it's Salesforce's material). See [Regenerating the catalog](#regenerating-the-catalog) below.

### 2. Create a Salesforce Connected App

1. In Salesforce Setup, go to **App Manager → New Connected App**.
2. Enable **OAuth Settings**.
3. Add the scope **`pardot_api`** (Manage user data via APIs).
4. Enable the **Client Credentials Flow** and assign a run-as user.
5. Copy the **Consumer Key** and **Consumer Secret**.

> The Postman collection uses the OAuth 2.0 *implicit* grant, which cannot be used by a server. This MCP server uses the **client-credentials** grant instead.

### 3. Find your Business Unit ID

Salesforce Setup → **Account Engagement → Business Unit Setup**. It looks like `0UvXXXXXXXXXXXXX`. This is sent as the `Pardot-Business-Unit-Id` header on every request.

### 4. Configure

Copy `.env.example` to `.env` and fill it in, or set the variables in your MCP client config.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PARDOT_CLIENT_ID` | ✅ | — | Connected App consumer key |
| `PARDOT_CLIENT_SECRET` | ✅ | — | Connected App consumer secret |
| `PARDOT_BUSINESS_UNIT_ID` | ✅ | — | Pardot Business Unit ID |
| `PARDOT_LOGIN_URL` | | `https://login.salesforce.com` | Use `https://test.salesforce.com` for sandboxes |
| `PARDOT_API_DOMAIN` | | `https://pi.pardot.com` | Pardot API host |
| `PARDOT_TIMEOUT_MS` | | `60000` | Request timeout |
| `PARDOT_MAX_RETRIES` | | `3` | Retries for 429/5xx |
| `PARDOT_ALLOW_DESTRUCTIVE` | | `false` | Enables `DELETE` and destructive `/do/` calls |
| `PARDOT_DEBUG` | | `false` | Log HTTP requests to stderr |

---

## Client configuration

### VS Code / GitHub Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "pardot": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/pardot-mcp-server/dist/index.js"],
      "env": {
        "PARDOT_CLIENT_ID": "${input:pardot-client-id}",
        "PARDOT_CLIENT_SECRET": "${input:pardot-client-secret}",
        "PARDOT_BUSINESS_UNIT_ID": "${input:pardot-business-unit-id}"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pardot": {
      "command": "node",
      "args": ["/absolute/path/to/pardot-mcp-server/dist/index.js"],
      "env": {
        "PARDOT_CLIENT_ID": "your_key",
        "PARDOT_CLIENT_SECRET": "your_secret",
        "PARDOT_BUSINESS_UNIT_ID": "0UvXXXXXXXXXXXXX"
      }
    }
  }
}
```

---

## Usage examples

Once connected, you can ask the model things like:

> *"Find the Pardot endpoint for querying prospects, then list the 10 most recently created prospects with their email and score."*

The model will call `pardot_list_endpoints` → `pardot_describe_endpoint` → `pardot_query`.

> *"Add tag 42 to campaign 12345."*

→ `pardot_action` with `endpointId: "campaign.add-tag"`.

### Important: the `fields` parameter

Most Pardot V5 endpoints **require** a `fields` query parameter listing the columns to return:

```json
{ "fields": "id,email,firstName,lastName,score" }
```

Omitting it returns HTTP 400. The server surfaces this in error hints.

---

## Safety

- **Destructive operations are blocked by default.** `DELETE` endpoints and destructive `/do/` actions (`removeTag`, `cancel`, `undelete`) return a refusal unless `PARDOT_ALLOW_DESTRUCTIVE=true`.
- **Credentials never touch stdout.** All logging goes to stderr, keeping the stdio JSON-RPC channel clean.
- **Tokens are cached in memory** and refreshed 60s before expiry, with a single automatic re-auth on HTTP 401.

---

## Regenerating the catalog

The committed `catalog/endpoints.json` is generated from the official Salesforce Postman collection, **which is not bundled with this repository**. To regenerate it you'll need to supply that collection yourself:

1. Download the **Marketing Cloud Account Engagement API** collection from the [Salesforce Postman workspace](https://www.postman.com/salesforce-developers/workspace/salesforce-developers/) (or export it from Postman).
2. Run the generator, pointing it at your copy:

```bash
node scripts/generate-catalog.mjs /path/to/collection.json catalog/endpoints.json
```

Or, if you place the collection at `../Sources/Marketing Cloud Account Engagement API Reference.json`, the default paths work:

```bash
npm run generate
```

The generator infers JSON Schemas from the collection's sample request bodies, extracts path/query parameters and their required flags, and classifies each endpoint by kind.

> **Note:** inferred body schemas are advisory. Because the collection only ships *sample* bodies, `required` is deliberately omitted from JSON body schemas — see [Notes and limitations](#notes-and-limitations).

---

## Project layout

```
pardot-mcp-server/
├── catalog/
│   └── endpoints.json          # generated: 238 endpoints
├── scripts/
│   ├── generate-catalog.mjs    # Postman collection -> catalog
│   └── smoke-test.mjs          # end-to-end MCP client test
├── src/
│   ├── index.ts                # server entrypoint (stdio)
│   ├── config.ts               # env-driven configuration
│   ├── auth.ts                 # OAuth 2.0 client-credentials manager
│   ├── client.ts               # HTTP client (retries, form-data, 401 re-auth)
│   ├── catalog.ts              # catalog loading + search
│   └── tools.ts                # the 8 MCP tools
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Testing

```bash
node scripts/smoke-test.mjs
```

This connects a real MCP client over stdio and verifies tool registration, catalog browsing, endpoint description, fuzzy-match suggestions, the destructive-operation guard, verb/kind validation, and path-parameter validation. It requires **no credentials**.

---

## Notes and limitations

- **Not officially supported by Salesforce.** The source collection is provided as-is; this server is an independent wrapper.
- **Rate limits apply.** Pardot enforces daily API call limits per business unit. The client retries `429` with backoff, but sustained heavy use will still hit the cap.
- **Schema inference is heuristic.** Request body schemas are inferred from the collection's sample values, so field types are best-effort (e.g. a sample `"0"` for an id may infer `string`). Treat them as guidance, not a strict contract.
- **Body schemas are advisory, not prescriptive.** The Postman collection only ships *sample* bodies, so every property appears in the sample. The generator therefore deliberately omits `required` from inferred JSON body schemas — marking all 36 fields of `prospect.update` as required would be wrong for a partial PATCH. Only form-data endpoints (where the fields genuinely are mandatory) carry `required`.
- **File uploads** (`File Create`, `Import Batch`, `Engagement Studio Program Create with File`) accept an absolute path on disk via the `formData` parameter.

## License

MIT
