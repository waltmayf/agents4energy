# Spike #514 — AWS Blocks feasibility findings

Throwaway spike for the Amplify → AWS Blocks migration epic (#513). This directory is not
meant to be merged or maintained; see the verdict posted on #514 and #513 for the actual
go/no-go decision. This file is the working log behind that verdict.

See git history on this file's directory for the sequence of experiments. Summary per
acceptance criterion:

1. **`npm run dev` fully local** — PASS. `npm run dev:server` / `npm run test:e2e` need no
   AWS credentials; Cognito, DynamoDB, and Realtime are all mocked to `.bb-data/`.
2. **Typed RPC, no codegen** — PASS. See `aws-blocks/index.ts` (Agent/McpServer slice) and
   `src/index.ts`. Swapping the scaffold's todo API for this slice broke the old
   `test/e2e.test.ts` with ~20 `TS2339` compile errors — the exact "signature change surfaces
   a frontend compile error" property the criterion is testing.
3. **`fromExisting` binds real Cognito + DynamoDB** — PASS, verified against live AWS (not
   just synth). See `aws-blocks/index.ts`'s `AuthCognito.fromExisting(...)` /
   `DistributedTable.fromExisting(...)` calls, pointed at the deployed `main` sandbox's user
   pool and `Agent`/`McpServer` tables.
4. **Identity-pool SigV4 creds in the browser** — FAILS as literally specified; real escape
   hatch exists. `AuthCognito` never provisions a Cognito Identity Pool and never vends AWS
   credentials to the browser (confirmed in `@aws-blocks/bb-auth-cognito`'s own DESIGN.md:
   "Blocks uses User Pools only, not Identity Pools; to call AWS from the browser, use the
   Lambda's own IAM role"). Amplify's `auth` construct — what `web/` uses today — does
   auto-provision one (confirmed via `aws cloudformation describe-stack-resources` against
   the live `amplify-web-main-sandbox` `auth` stack: a real `AWS::Cognito::IdentityPool`
   exists there). That Identity Pool is exactly what `harness-agent.ts`'s
   `fetchAuthSession()` federates into today.
5. **`AgentCoreApplication` synths inside the Blocks CDK app** — PASS, with a version-pinning
   caveat. See `aws-blocks/agentcore-synth-experiment.cdk.ts` (imports the real, unmodified
   `web/amplify/constructs/agentCoreApplication.ts` + `agentcore.config.ts`). `cdk synth`
   produced a correct 25-resource template (Memory, PolicyEngine, 2 Runtimes + CodeBuild/ECR,
   6 IAM roles) once `aws-cdk-lib`/`constructs` in this scaffold were pinned to the exact
   versions `web/` uses (2.258.1 / 10.6.0) — a mismatch doesn't break `cdk synth` (`tsx`
   doesn't type-check) but does break the mandatory `tsc` gate with a
   "types have separate declarations of a private property" error, since the two are
   physically separate installs of `constructs`.
6. **Sandbox deploy end-to-end** — PASS. `npm run sandbox` deployed real infra in ~131s.
   Signed in as the project's real e2e test user (`/agentcore/e2e-test-user-web-main/*` in
   SSM) against the live Cognito pool and called `listAgents`/`listMcpServers` over the
   deployed API — got back real production rows with zero table/pool recreation. Only read
   ops were exercised against the live tables (no `createAgent`), to avoid polluting
   production data. Destroyed cleanly with `npm run sandbox:destroy`; verified no stray
   CloudFormation stacks remain.

## Mechanism decision for #4 (identity-pool creds)

Creds do **not** come from `AuthCognito` directly — there is no equivalent of Amplify's
auto-provisioned Identity Pool. The viable path is: (a) hand-add a raw-CDK
`aws-cognito.CfnIdentityPool` trusting the same user pool + client `AuthCognito` uses (only
needs the ID strings, not a live construct reference from `AuthCognito`), (b) add a thin
`ApiNamespace` method that calls `auth.fetchAuthSession(context)` — the one sanctioned
token-egress API — and returns the ID token to the browser, (c) client-side, feed that token
into `fromCognitoIdentityPool()` (`@aws-sdk/credential-providers`) to mint temporary AWS
credentials, then sign `InvokeHarnessCommand` exactly as `harness-agent.ts` does today. This
was not deployed end-to-end in this spike (time-boxed) — it should be the first thing built
and validated against a real `MyHarness` invoke before Phase 1 commits UI work to it.
