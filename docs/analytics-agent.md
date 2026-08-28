# Analytics (PySpark) agent

`packs/data-lake-analytics/` — a use-case-pack agent (slug `data-lake-analytics`) that runs
ad-hoc PySpark queries against a data lake via Amazon Athena for Spark, and renders any
plots/artifacts it produces back into the chat UI. Ships as part of epic #498 (HPC/Analytics
agents): PySpark tools in #501 (epic slice 3), this pack in #506/#522 (slice 8).

## What it does

The agent has two MCP tool servers:

- **Athena PySpark Tools** — `SubmitPySpark` / `GetPySparkStatus` / `GetPySparkResults`, a
  submit → poll → results trio backed by an Athena-for-Spark (PySpark engine v3) session.
- **S3 Filesystem Tools** — `ListFiles` / `ReadFile` / `ApplyDiff` / `DeleteFile` (and,
  transitively, `UploadFile` — see [`docs/agent-filesystem.md`](agent-filesystem.md)) against
  the shared `agentWorkspace` bucket, for inspecting scripts/data and confirming artifacts
  after a run.

Its system prompt (`packs/data-lake-analytics/system-prompt.md`) instructs the model to:
submit → poll (never guess a runtime, keep polling `GetPySparkStatus`) → fetch results; prefer
saving plots as interactive HTML over static images; and never fabricate results if the
requested data isn't available in the lake.

## Running a query — the submit/poll/results flow

1. **`SubmitPySpark`** (`code`, `subdir`, optional `description`) — ensures a live Athena
   session exists for that `subdir` (reusing one if found, else starting a new one and
   bounded-waiting up to 90s for it to reach `IDLE`), then starts a
   `StartCalculationExecution` with the user's code wrapped in setup/pre/post-execution
   Python. Returns `{status: "submitted", sessionId, calculationId, subdir, artifactsPrefix}`
   — or `{status: "pending", ...}` with a retry hint if the session is still cold-starting
   (first job in a while; can take 40-90s+). The agent is told to retry `SubmitPySpark` with
   the **same** `subdir` rather than starting a duplicate session.
2. **`GetPySparkStatus`** (`calculationId`) — polls `GetCalculationExecution`, returning
   `state`, `stateChangeReason`, `progressPercent`, and DPU-seconds consumed so far.
3. **`GetPySparkResults`** (`calculationId`, `subdir`) — once the calculation reaches a
   terminal state (`COMPLETED`/`FAILED`/`CANCELED`), reads back `stdout`/`stderr`/`result`
   from their S3 URIs (truncated to 20,000 characters each — full output stays in S3) and
   lists every file written under that run's artifacts prefix.

`subdir` is an explicit, agent-supplied argument (not an implicit session global) — it both
scopes the Athena session (tagged `[ChatSessionID:<subdir>]` in its `Description` so a
matching live session is reused across calls) and the S3 prefix artifacts land under.

See `web/amplify/functions/athena-pyspark/handler.ts` for the implementation, and
[`docs/hpc-analytics-agents-epic.md`](hpc-analytics-agents-epic.md) (Slice 3) for the original
design writeup — including the "long-running tools" pattern this trio follows (Lambda timeouts
are far shorter than an Athena Spark job, so no single call blocks for the whole run).

## Artifact rendering under `files/artifacts/`

The composability requirement driving this design: MCP tools cannot call each other directly
(an AgentCore Gateway target Lambda has no in-process MCP client), so the PySpark tool cannot
"call" the S3 upload tool. Instead both share a code library —
[`web/lib/s3-fs-upload.ts`](../web/lib/s3-fs-upload.ts) — and the PySpark path uses
**in-session auto-upload** instead of an extra tool call:

- **In the Lambda (TypeScript):** `athena-pyspark/handler.ts` calls
  `resolveArtifactsPrefix(subdir)` to compute where this run's artifacts should land
  (`files/artifacts/<subdir>/`) and templates that path into the injected Python as
  `{{ARTIFACTS_S3_PREFIX}}` — it never uploads anything itself, because plots don't exist on
  the Lambda.
- **In the Spark session (Python, on the Athena Spark worker):** the composed script is
  `sessionSetup.py` + `preExecution.py` + the user's code + `postExecution.py`
  (`athena-pyspark/loadScript.ts` does the templating/composition). The user's PySpark code
  writes plots/data to its working directory as normal (e.g. `plots/my_chart.html`);
  `postExecution.py`'s `upload_working_directory()` then boto3-uploads that whole working
  directory to the templated artifacts prefix **automatically at end of run** — no tool call
  spent on it.

Artifacts always land at `files/artifacts/<subdir>/...` in the `agentWorkspace` bucket. The
upload runs under the **Athena Spark execution role**, not the Lambda's role — that role is
granted `s3:PutObject` on `files/artifacts/*` (`athenaPySparkWorkgroup` construct), which is a
common trap if the tool "succeeds" but no file shows up.

### From S3 key to a rendered iframe

The system prompt tells the model: when a tool has written a file under
`files/artifacts/<subdir>/...`, reference it in the response as
`<iframe src="/artifacts/<subdir>/...">` — never markdown image syntax (`![alt](url)`), and
always a relative path.

The frontend resolves that at render time, ported from `reference/genai-demos`:

1. [`web/lib/artifacts-preprocessing.ts`](../web/lib/artifacts-preprocessing.ts) rewrites any
   `/artifacts/<rel>` href — or `<iframe src="/artifacts/<rel>">` embedded inside a larger HTML
   blob — to `/file?s3Key=files%2Fartifacts%2F<rel>`. Unlike the genai-demos original there is
   no per-chat-session artifact prefix here; every artifact lives under the single shared
   `files/artifacts/` root (same flat-namespace model as the rest of the agent filesystem —
   see [`docs/agent-filesystem.md`](agent-filesystem.md)).
2. `web/app/(with-auth)/file/page.tsx` (the `/file` route) reads the `s3Key` query param,
   validates it resolves under `files/` (`resolveFileRouteKey` in
   `web/lib/s3-fs-path.ts` — this route can never be used to presign an arbitrary bucket key),
   gets a presigned URL via `getUrl`, and renders it inline based on detected file type
   (`image`, `html`, `markdown`, `pdf`, or a raw download link otherwise).

So a PNG or self-contained HTML plot written under `files/artifacts/<subdir>/plots/foo.png`
by a PySpark run shows up as a live iframe in the chat transcript with zero extra tool calls —
the Spark session already put it there, and the frontend already knows how to resolve
`/artifacts/...` hrefs to a presigned S3 URL.

## Data lake

The pack targets Amazon Athena for Spark against Glue-catalog tables backed by S3 — set up by
the `athenaPySparkWorkgroup` (workgroup, Spark execution role) and `dataLakeSeed` (sample Glue
database/tables) constructs from epic Slice 2. See
[`docs/hpc-analytics-agents-epic.md`](hpc-analytics-agents-epic.md#slice-2--athena-pyspark-workgroup--spark-execution-role--data-lake-seed-no-deps)
for the exact resources.

## Deploying and known limitations

Deploy with `./scripts/deploy-pack.sh data-lake-analytics` (see
[`docs/use-case-packs.md`](use-case-packs.md) for the general pack-deploy flow and the
sandbox-specific gateway-URL caveat this pack's manifest is subject to).

As of PR #522 (Slice 8), the pack's S3-half was verified live end-to-end against the deployed
`main` sandbox; the PySpark half was blocked by #524 (the `Athena PySpark Tools` gateway target
wasn't registered on the shared sandbox's live gateway) — #524 has since merged, so a fresh
deploy should register the target and unblock a full query → plot → artifact-render run.
