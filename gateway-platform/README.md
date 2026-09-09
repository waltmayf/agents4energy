# gateway-platform

Standalone [AWS Blocks](https://github.com/aws/blocks) app that will own the AgentCore Gateway +
pack platform for the standalone gateway-platform epic (#532), isolated from the Amplify app in
`web/`. This slice (#534) scaffolds the app skeleton, deploy tooling, the credential-free CI synth
gate, and an SSM output stub — **no gateway targets yet**. The real `AgentCore Gateway` +
`CUSTOM_JWT` authorizer construct lands in #535, following the pattern proven in spike #533
(PR #542, `spikes/gateway-blocks-poc/`).

> Scaffolded with `npx @aws-blocks/create-blocks-app gateway-platform --template backend`

This is a plain `npm` project (own `package.json`/lockfile), **not** part of the repo's root
`pnpm` workspace (`pnpm-workspace.yaml` only lists `web` and `packages/shared-types`) — it is
deployed, installed, and versioned independently of `web/`.

## Deploy / destroy

```bash
npm install
npm run sandbox   # deploy to a personal AWS sandbox stack (cdk watch --hotswap keeps it in sync)
npm run deploy    # deploy the production stack
npm run destroy   # tear down whichever stack you deployed
npm run dev       # local mock RPC server, http://localhost:3001, zero AWS credentials needed
npm run test:synth  # credential-free `cdk synth` gate — see below
```

## Credential-free CI synth gate

`npm run test:synth` (`scripts/check-cdk-synth.mjs`) runs `cdk synth` against
`aws-blocks/index.cdk.ts` with no AWS credentials and checks every synthesized
`*.template.json` for CloudFormation resource-dependency cycles (same check
`web/`'s `pnpm test:synth` does — see AGENTS.md "GitHub Pull Requests"). Wired
into CI at `.github/workflow-drafts/gateway-platform-synth.yml` (or
`.github/workflows/` if already promoted) — runs on any PR touching
`gateway-platform/**`.

## SSM output plumbing (gateway coordinates)

Once a gateway is deployed here, its id/endpoint/ARN are meant to be read by other services
(e.g. `web/`'s Amplify app) — the same "one service publishes, others read via SSM" pattern
`web/` already uses for its own AgentCore resources (see AGENTS.md "Key Constraints" —
`/agentcore/<stackName>/…`).

**Convention (defined now, populated for real in #535):**

- **Path:** `/gateway-platform/<stackName>/gateway` (a single SSM `String` parameter per
  deployed stack — sandbox and production each get their own path since `stackName` differs).
- **Value:** a JSON blob with keys `gatewayId`, `gatewayEndpoint`, `gatewayArn`.
- **Today:** `aws-blocks/ssm-gateway-outputs.cdk.ts` publishes a placeholder blob
  (`PENDING-see-issue-535` for all three keys) from every deploy, so the path and key names are
  locked in before #535 wires up the real `AgentCoreMcp` gateway construct and swaps in its real
  CDK-token attributes (`attrGatewayIdentifier` / `attrGatewayUrl` / `attrGatewayArn`).
- **Reading it (from a separate process, no Blocks/CDK context needed):**
  ```bash
  aws ssm get-parameter --name /gateway-platform/<stackName>/gateway --query Parameter.Value --output text
  ```

Why raw `ssm.StringParameter` instead of the Blocks `AppSetting` building block: the gateway's
attributes are CDK tokens on a **separate, bare `cdk.Stack`** with no Blocks `Scope` in its
construct tree (see `ssm-gateway-outputs.cdk.ts`), so there's nothing to hang an `AppSetting` off
on the write side. If a Blocks-hosted consumer inside `aws-blocks/index.ts` ever needs to read
these values from within its own `Scope`, `AppSetting.fromExisting(scope, id, { name })` is the
right tool for that read side — see spike #533's `FINDINGS.md` (criterion 3) for the full
reasoning.

## Environment gotchas (carried over from spike #533)

Both are one-line fixes, but the failure modes give no hint toward the real cause — see spike
#533's `FINDINGS.md` for the full writeup:

- **`AWS_EC2_METADATA_DISABLED=false` before `npm run sandbox` / `npm run deploy` / `cdk deploy`**
  in a non-EC2 container credential environment. The bundled `aws-cdk` CLI auto-sets
  `AWS_EC2_METADATA_DISABLED=true` unless the var is already set, which breaks credential
  resolution when the container's credentials actually come through an IMDS-compatible endpoint.
  Symptom without the fix: `"Unable to resolve AWS account to use"`.
- **`uv` (Python packaging) must be installed** before any deploy that bundles a Python Lambda —
  `@aws/agentcore-cdk`'s `McpLambdaCompute` (used once #535 adds the gateway's Lambda tool
  targets) requires it even in an otherwise-TypeScript app. Install via
  `curl -LsSf https://astral.sh/uv/install.sh | sh`.
- **`NODE_OPTIONS="--conditions=cdk"` before any raw `cdk` CLI invocation** (`cdk synth`,
  `cdk deploy`, etc. run directly rather than through `npm run sandbox`/`deploy`/`destroy`, which
  set this automatically) — without it, Building Blocks silently loads mock implementations
  instead of real CDK constructs and synth produces an empty/wrong stack with no error.

Also carried over from spike #533 / PR #542, for #535's real gateway construct (not needed yet —
no `@aws/agentcore-cdk` import exists in this app today):

- **`createRequire` workaround** — `@aws/agentcore-cdk` only declares a `"require"` export
  condition, so a static `import` of its value bindings (not just types) fails under ESM; use
  `const require = createRequire(import.meta.url); const { AgentCoreMcp } = require('@aws/agentcore-cdk')`.
- **`agentcore.json` sentinel** — `AgentCoreMcp`'s constructor calls `findConfigRoot()`
  unconditionally and throws if it can't find a directory literally named `agentcore/` containing
  a file literally named `agentcore.json` (contents are never read). Add
  `aws-blocks/agentcore/agentcore.json` + `setSessionProjectRoot(__dirname)` pointed at
  `aws-blocks/` when #535 lands, mirroring `web/amplify/agentcore/agentcore.json`.
- **CDK version pinning** — this scaffold already pins `aws-cdk-lib@2.257.0` / `constructs@^10.6.0`,
  close enough to `web/`'s `^2.248.0` that `@aws/agentcore-cdk` installs and type-checks cleanly
  with no manual override (confirmed in spike #533).

---

## Blocks scaffold docs (auto-generated)

Backend-only TypeScript API with AWS Blocks — no frontend included.

## For Coding Agents

**CRITICAL: Always read documentation from `node_modules/@aws-blocks/blocks/README.md` to understand the Building Block system and available APIs.**

**After making code changes, always run `npm run typecheck` to verify TypeScript types are correct.**

## Documentation Location

**All Blocks documentation is in `node_modules/@aws-blocks/blocks/README.md`:**

The Blocks package handles infrastructure, backend logic, APIs, storage, authentication, and more through Building Blocks. Read the README to discover available Building Blocks and their usage.

## For Humans

**Hover in IDE:** Import a Building Block and hover over it to see comprehensive docstrings with usage, best practices, and performance characteristics.

## Commands

```bash
npm run typecheck   # Check TypeScript types (run after code changes)
npm run dev         # Local dev server (long-running - use background job)
npm run sandbox     # Deploy to AWS sandbox
npm run deploy      # Deploy to production
npm run test:e2e    # Run end-to-end tests against dev server
```

## Local dev vs Sandbox vs Deploy (process model)

| Command | Backend | API URL |
|---------|---------|---------|
| `npm run dev` | Local RPC dev server on http://localhost:3001 | `http://localhost:3001` |
| `npm run sandbox` | Deployed to AWS, `cdk watch --hotswap` keeps it in sync | Deployed API Gateway URL |
| `npm run deploy` | Deployed to AWS | Deployed API Gateway URL |

### RPC endpoint (local dev)

```bash
# The dev server's RPC endpoint is JSON-RPC 2.0 at POST /aws-blocks/api:
curl -X POST http://localhost:3001/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.greet","params":["World"],"id":1}'
# method = "<namespace>.<methodName>" (namespace = first arg of ApiNamespace); params = positional array.
# Errors return HTTP 200 with an {"error":{...}} body (JSON-RPC), not a non-2xx status.
```

## Architecture

- **Backend:** `aws-blocks/index.ts` — Define APIs and Building Blocks
- **Infrastructure:** Inferred from code, works locally and on AWS

**Read `node_modules/@aws-blocks/blocks/README.md` for complete documentation.**

## Stack naming

Your CloudFormation stack names are derived from the `stackId` in `.blocks/config.json` — generated at scaffold time from your project name plus a random suffix (e.g., `my-app-a3x9kf`). Production deploys as `<stackId>-prod` and sandbox as `<stackId>-<username>-<random>`, where the sandbox identifier is per-machine and stored in `.blocks-sandbox/sandbox-id.txt` (gitignored). This lets multiple developers share a testing account without colliding.

To change the stack name, edit `stackId` in `.blocks/config.json`. For dynamic naming logic, modify `aws-blocks/index.cdk.ts` directly.

## Adding a Frontend Later

This template is backend-only. To add a frontend:

1. **React/Vite frontend:**
   ```bash
   npm create vite@latest src -- --template react-ts
   ```
   Then add to `package.json` (rename existing `dev` → `dev:server`):
   ```json
   {
     "scripts": {
       "build": "tsc && vite build",
       "dev:server": "tsx watch aws-blocks/scripts/server.ts",
       "dev:client": "vite",
       "dev": "concurrently \"npm:dev:server\" \"npm:dev:client\""
     },
     "dependencies": {
       "react": "^19.0.0",
       "react-dom": "^19.0.0"
     },
     "devDependencies": {
       "@vitejs/plugin-react": "^4.3.0",
       "vite": "^5.0.0",
       "concurrently": "^8.2.0"
     }
   }
   ```

2. **Import APIs in your frontend:**
   ```ts
   import { api } from 'aws-blocks';
   const result = await api.greet('World');
   ```

3. **Add Hosting to `aws-blocks/index.cdk.ts`:**
   ```ts
   import { Hosting } from '@aws-blocks/blocks/cdk';

   if (!sandboxMode) {
     new Hosting(blocksStack, 'Hosting', {
       root: join(__dirname, '..'),
       buildCommand: 'npm run build',
       buildOutputDir: 'dist',
       api: blocksStack
     });
   }
   ```

The `aws-blocks` workspace package re-exports a type-safe client that works in both Node.js and browser environments.
