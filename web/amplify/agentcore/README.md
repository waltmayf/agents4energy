# agentcore/

Container/prompt sources for the AgentCore resources this repo deploys, plus
one required-but-inert file:

- **`agentcore.config.ts`** — the real config (memories, runtimes, policy
  engines, gateway base specs). `web/amplify/backend.ts` imports this and
  feeds it to the `AgentCoreApplication` L3 CDK construct
  (`web/amplify/constructs/agentCoreApplication.ts`). This is the only source
  of truth for AgentCore resource config — there is no `agentcore deploy`
  step; the Amplify backend deploy (`ampx sandbox` / pipeline deploy) owns
  these resources directly.
- **`agentcore.json`** — a near-empty sentinel: `{ "name": "agentcore",
  "version": 1 }`. `@aws/agentcore-cdk@0.1.0-alpha.46`'s `findConfigRoot()`
  throws at synth unless a directory literally named `agentcore/` contains a
  file literally named `agentcore.json` — it only checks that the file
  *exists*, it never reads its contents. Do not delete this file or its
  contents will be missed by the SDK's existence check; do not put real
  config back into it.
- **`ClaudeCode/`**, **`AguiAgent/`** — container build contexts for the
  ClaudeCode and AguiAgent AgentCore Runtimes. Each `Dockerfile` only `COPY`s
  files from within its own directory. `agentcore.config.ts` points each
  runtime's `codeLocation` at an absolute path (resolved from
  `import.meta.url`), so these can move independently of the sentinel above.
  Both are excluded from `web`'s and `web/amplify`'s TypeScript programs
  (see `tsconfig.json`/`tsconfig.test.json`/`amplify/tsconfig.json`) — their
  dependencies only exist inside their container images.
- **`MyHarness/`** — `system-prompt.md` for the `MyHarness` harness. Read
  from disk by `backend.ts` at synth time; everything else about the harness
  (model, tools, memory reference, truncation, auth) is an inlined
  `HarnessSpec` literal in `backend.ts` so the Cognito authorizer can be
  injected per-deployment.
