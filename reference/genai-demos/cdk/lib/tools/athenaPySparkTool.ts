import { z } from "zod";
import { tool } from "ai";
import { AthenaClient, StartCalculationExecutionCommand, GetCalculationExecutionCommand, StartSessionCommand, GetSessionCommand, GetSessionStatusCommand, ListSessionsCommand } from '@aws-sdk/client-athena';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { getChatSessionId, getChatSessionPrefix } from "./toolUtils";
import { writeFileTool } from "./s3Toolbox";
import { loadPythonScript } from "./python/loadScript";
import { extractSparkSqlStatements } from "./pysparkSqlExtractor";
import { parseSqlForLineage } from "../lineage/sqlParser";
import { emitLineageEvent } from "../lineage/lineageEmitter";
import type { LineageDataset } from "../lineage/lineageTypes";
import { sessionLineageTracker } from "./sessionLineageTracker";

/** Format a result object as YAML for readable tool output (multiline strings use block scalars) */
function formatResult(data: Record<string, unknown>): string {
    return yaml.dump(data, { lineWidth: -1, noRefs: true });
}

// Environment variables
const getAthenaWorkgroup = () => process.env.ATHENA_PYSPARK_WORKGROUP_NAME;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

export const getSessionSetupScript = () => {
    return '\n' + loadPythonScript('sessionSetup.py', {
        STORAGE_BUCKET_NAME: process.env.STORAGE_BUCKET_NAME ?? '',
        CHAT_SESSION_PREFIX: getChatSessionPrefix(),
        AWS_REGION: AWS_REGION,
    });
};


export const getPreCodeExecutionScript = (script: string) => {
    // Match quoted strings that look like file paths (letters, digits, slashes, dots, hyphens, underscores only)
    const filePathRegex = /['"]([a-zA-Z0-9_./\-]+\.[a-zA-Z0-9]{2,4})['"](?:\s*[,)}]|\s*$|\s*\n|$)/g;
    const matches = script?.match(filePathRegex) || [];
    const filePaths = matches.map(match => {
        const pathMatch = match.match(/['"]([a-zA-Z0-9_./\-]+\.[a-zA-Z0-9]{2,4})['"]/);
        return pathMatch ? pathMatch[1] : null;
    }).filter(Boolean);
    const filesToDownload = [...new Set(filePaths)];
    console.log(`Files to download: ${JSON.stringify(filesToDownload)}`);
    return `\nfiles_to_download = ${JSON.stringify(filesToDownload)}\n`
        + loadPythonScript('preExecution.py') + '\n\n';
};


export const getPostCodeExecutionScript = () => {
    return '\n' + loadPythonScript('postExecution.py');
};


async function readS3File(s3Uri: string): Promise<string> {
    try {
        if (!s3Uri.startsWith('s3:/')) throw new Error(`Invalid S3 URI: ${s3Uri}`);
        let uriWithoutProtocol: string;
        if (s3Uri.startsWith('s3://')) uriWithoutProtocol = s3Uri.substring(5);
        else if (s3Uri.startsWith('s3:/')) uriWithoutProtocol = s3Uri.substring(4);
        else throw new Error(`Unexpected S3 URI format: ${s3Uri}`);

        const firstSlashIndex = uriWithoutProtocol.indexOf('/');
        if (firstSlashIndex === -1) throw new Error(`Invalid S3 URI format: ${s3Uri}`);
        const bucket = uriWithoutProtocol.substring(0, firstSlashIndex);
        const key = uriWithoutProtocol.substring(firstSlashIndex + 1);
        console.log(`Parsing S3 URI: ${s3Uri} => Bucket: ${bucket}, Key: ${key}`);

        const s3Client = new S3Client({ region: AWS_REGION });
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3Client.send(command);
        if (!response.Body) throw new Error('No content found in S3 object');

        const chunks: Buffer[] = [];
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
            chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('utf8');
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error reading S3 file ${s3Uri}:`, error);
        return JSON.stringify({ error: `Error reading S3 object ${s3Uri}: ${message}` });
    }
}


/** Result type for executeCalculation — final result after the generator completes */
interface CalculationResult {
    success: boolean;
    state: string;
    calculationId?: string | undefined;
    resultData?: Record<string, unknown> | undefined;
}

/** Structured execution metrics yielded during polling */
interface ExecutionMetrics {
    state: string;
    elapsedSeconds: number;
    timeoutSeconds: number;
    progressPercent: number | null;
    dpuExecutionSeconds: number | null;
    calculationId: string;
    sessionId: string;
}

/** Yielded by executeCalculation during polling */
interface CalculationProgress {
    type: 'progress';
    message: string;
    metrics?: ExecutionMetrics;
}

type CalculationYield = CalculationProgress | ({ type: 'result' } & CalculationResult);

export async function* executeCalculation(
    athenaClient: AthenaClient, sessionId: string, code: string,
    description: string,
    options: {
        timeoutSeconds?: number; waitMessage?: string; successMessage?: string;
        failureMessage?: string; continueOnFailure?: boolean;
    } = {}
): AsyncGenerator<CalculationYield> {
    const {
        timeoutSeconds = 60, waitMessage = "⏳ Executing calculation...",
        successMessage = "✅ Calculation completed successfully",
        failureMessage = "❌ Calculation failed", continueOnFailure = false
    } = options;

    const clientRequestToken = uuidv4();
    const startCommand = new StartCalculationExecutionCommand({
        SessionId: sessionId, CodeBlock: code,
        Description: description, ClientRequestToken: clientRequestToken,
    });
    console.log(`Starting calculation execution: ${description}`);
    const startResponse = await athenaClient.send(startCommand);

    if (!startResponse.CalculationExecutionId) {
        yield { type: 'progress', message: `${failureMessage}: No calculation ID returned` };
        yield { type: 'result', success: false, state: 'FAILED' };
        return;
    }

    const calculationId = startResponse.CalculationExecutionId;
    console.log(`Calculation execution ID: ${calculationId}`);
    yield { type: 'progress', message: waitMessage };

    let finalState = 'CREATING';
    let resultData: Record<string, unknown> | null = null;
    const startTime = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    let lastProgress = '';

    while (finalState !== 'COMPLETED' && finalState !== 'FAILED' && finalState !== 'CANCELED' && Date.now() - startTime < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const getCommand = new GetCalculationExecutionCommand({ CalculationExecutionId: calculationId });
        try {
            const getResponse = await athenaClient.send(getCommand);
            finalState = getResponse.Status?.State || 'UNKNOWN';
            if (getResponse.Status?.StateChangeReason) console.log(`State change reason: ${getResponse.Status.StateChangeReason}`);

            // Extract rich statistics from the calculation execution
            const progress = getResponse.Statistics?.Progress;
            const dpuMillis = getResponse.Statistics?.DpuExecutionInMillis;
            const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);

            // Parse progress percentage from the string (e.g. "50%" or "100%")
            let progressPercent: number | null = null;
            if (progress) {
                const pctMatch = progress.match(/(\d+)%/);
                if (pctMatch?.[1]) progressPercent = parseInt(pctMatch[1], 10);
                if (progress !== lastProgress) lastProgress = progress;
            }

            const dpuSeconds = dpuMillis !== undefined && dpuMillis > 0 ? dpuMillis / 1000 : null;

            // Build a human-readable progress string for logs
            const parts: string[] = [`State: ${finalState}`];
            if (progressPercent !== null) parts.push(`Progress: ${progressPercent}%`);
            if (dpuSeconds !== null) parts.push(`DPU time: ${dpuSeconds.toFixed(1)}s`);
            parts.push(`Elapsed: ${elapsedSeconds}s / ${timeoutSeconds}s`);

            const progressLine = `⏳ ${parts.join(' | ')}`;
            yield {
                type: 'progress', message: progressLine,
                metrics: {
                    state: finalState, elapsedSeconds, timeoutSeconds,
                    progressPercent, dpuExecutionSeconds: dpuSeconds,
                    calculationId, sessionId,
                }
            };
            console.log(`Calculation: ${progressLine}`);

            if (getResponse.Status?.State && ['COMPLETED', 'FAILED', 'CANCELED'].includes(getResponse.Status.State) && getResponse.Result) {
                resultData = getResponse.Result as Record<string, unknown>;
            }
        } catch (error) { console.error(`Error getting calculation status: ${error}`); }
    }

    if (finalState === 'COMPLETED') {
        yield { type: 'progress', message: successMessage };
        yield { type: 'result', success: true, state: finalState, calculationId, resultData: resultData ?? undefined };
    } else {
        const msg = continueOnFailure ? `⚠️ Warning: ${failureMessage}: ${finalState}` : `${failureMessage}: ${finalState}`;
        yield { type: 'progress', message: msg };
        yield { type: 'result', success: false, state: finalState, calculationId, resultData: resultData ?? undefined };
    }
}


/** Maximum characters returned for stdout/stderr/result content to keep tool responses manageable */
const MAX_OUTPUT_CHARS = 20000;

function truncateOutput(content: string, label: string): string {
    if (content.length <= MAX_OUTPUT_CHARS) return content;
    const truncated = content.slice(0, MAX_OUTPUT_CHARS);
    const omitted = content.length - MAX_OUTPUT_CHARS;
    return `${truncated}\n\n... [${label} truncated — ${omitted.toLocaleString()} characters omitted. Full output available in S3.]`;
}

export async function fetchCalculationOutputs(resultData: Record<string, unknown> | undefined) {
    let stdoutContent = "";
    let stderrContent = "";
    let resultContent = "";
    const data = resultData as { StdOutS3Uri?: string; ResultS3Uri?: string; StdErrorS3Uri?: string } | undefined;

    try {
        if (data?.StdOutS3Uri) {
            const stdoutResult = await readS3File(data.StdOutS3Uri);
            try { const parsed = JSON.parse(stdoutResult); if (parsed.error) { console.error('Error reading stdout:', parsed.error); } else { stdoutContent = stdoutResult; } }
            catch { stdoutContent = stdoutResult; }
        }
        if (data?.ResultS3Uri) {
            const resultS3Content = await readS3File(data.ResultS3Uri);
            try { const parsed = JSON.parse(resultS3Content); if (parsed.error) { console.error('Error reading result:', parsed.error); } else { resultContent = resultS3Content; } }
            catch { resultContent = resultS3Content; }
        }
        if (data?.StdErrorS3Uri) {
            const stderrS3Content = await readS3File(data.StdErrorS3Uri);
            try { const parsed = JSON.parse(stderrS3Content); if (parsed.error) { console.error('Error reading stderr:', parsed.error); } else { stderrContent = stderrS3Content; } }
            catch { stderrContent = stderrS3Content; }
        }
    } catch (error) {
        console.error('Error fetching calculation output:', error);
    }
    return {
        stdout: truncateOutput(stdoutContent, 'stdout'),
        result: truncateOutput(resultContent, 'result'),
        stderr: truncateOutput(stderrContent, 'stderr'),
        s3: { stdout: data?.StdOutS3Uri, result: data?.ResultS3Uri, stderr: data?.StdErrorS3Uri }
    };
}


async function findExistingSession(athenaClient: AthenaClient, chatSessionId: string): Promise<string | null> {
    try {
        console.log(`Looking for existing session for chat session: ${chatSessionId}`);
        const listSessionsCommand = new ListSessionsCommand({ WorkGroup: getAthenaWorkgroup(), StateFilter: 'IDLE' });
        const response = await athenaClient.send(listSessionsCommand);
        if (!response.Sessions || response.Sessions.length === 0) { console.log('No active sessions found'); return null; }
        const matchingSession = response.Sessions.find(session =>
            session.Description?.includes(`[ChatSessionID:${chatSessionId}]`) &&
            session.SessionId && session.Status?.State !== 'TERMINATED'
        );
        if (matchingSession?.SessionId) { console.log(`Found existing session: ${matchingSession.SessionId}`); return matchingSession.SessionId; }
        console.log('No matching session found for this chat session ID');
        return null;
    } catch (error) { console.error('Error finding existing session:', error); return null; }
}

async function isSessionActive(athenaClient: AthenaClient, sessionId: string): Promise<{ isActive: boolean; state: string }> {
    try {
        const response = await athenaClient.send(new GetSessionStatusCommand({ SessionId: sessionId }));
        const state = response.Status?.State || 'UNKNOWN';
        if (state === 'IDLE') { console.log(`Session ${sessionId} is active and idle`); return { isActive: true, state }; }
        console.log(`Session ${sessionId} is not in IDLE state, current state: ${state}`);
        return { isActive: false, state };
    } catch (error) { console.error(`Error checking session status for ${sessionId}:`, error); return { isActive: false, state: 'ERROR' }; }
}


/** PySpark tool result type — yielded as progress updates and final result */
interface PySparkToolResult {
    status: 'progress' | 'completed' | 'error';
    message: string;
    output?: string | undefined;
    metrics?: ExecutionMetrics | undefined;
}

const pysparkInputSchema = z.object({
    code: z.string().describe("PySpark code to execute. This code will be saved to scriptPath before execution. The 'spark' session is already initialized."),
    timeout: z.number().optional().default(300).describe("Timeout in seconds for the execution"),
    description: z.string().optional().describe("Optional description for the execution"),
    scriptPath: z.string().describe("Path for the script file. If code is provided, the script will be saved here. Must start with 'scripts/'"),
});

export const createPysparkTool = (props: { additionalSetupScript?: string; additionalToolDescription?: string } = {}) => tool({
    description: `Execute PySpark code in an AWS Athena session and return the results.

**Environment**
- A \`spark\` session is pre-initialized — do not create or modify the Spark configuration.
- Available libraries: matplotlib, numpy, scipy, scikit-learn, pyarrow, pandas, pytz, mpmath, kiwisolver.

**Working with files**
- Files referenced in your script (e.g., 'data.csv') are automatically downloaded from S3 to the working directory before execution. Reference them by filename only — no S3 path needed.
- Before reading a CSV, inspect it first to confirm column names and data types.
- Prefer pandas (\`pd.read_csv()\`) over Spark for loading local files — it's simpler and avoids schema inference issues. Convert to a Spark DataFrame with \`spark.createDataFrame(pdf)\` when needed.
- All files in the working directory are automatically uploaded to the session's S3 artifacts after execution. Do NOT manually upload files to S3 (e.g., via boto3 s3_client.put_object) — the system handles this for you.
  - Save data files to: \`data/\`
  - Save plot files to: \`plots/\`
- Prefer pandas (\`df.to_csv()\`) over Spark for saving DataFrames.
- Do NOT import or use boto3 for S3 operations. Do NOT hardcode S3 bucket names or keys.

**Creating Iceberg tables**
- Use \`saveAsTable()\` to create and populate an Iceberg table in one step:
  \`\`\`python
  df_spark.write.format("iceberg").mode("overwrite").saveAsTable("my_db.my_table")
  \`\`\`

**Querying Federated Data Sources (Athena Federation)**
- Use the pre-configured \`listFederatedCatalogs()\` to discover available federated data sources.
- Use the pre-configured \`query_federated()\` helper to query federated data sources. It returns a Spark DataFrame.
- Syntax: \`df = query_federated('SELECT * FROM "catalog_name"."database"."table" LIMIT 100')\`
- Or with catalog shorthand: \`df = query_federated('SELECT * FROM database.table LIMIT 100', catalog='catalog_name')\`
- Examples:
  - Snowflake: \`df = query_federated('SELECT * FROM "snowflake-tpch"."TPCH_SF1"."NATION" LIMIT 10')\`
  - With catalog param: \`df = query_federated('SELECT * FROM TPCH_SF1.NATION LIMIT 10', catalog='snowflake-tpch')\`
- The result is a standard Spark DataFrame — you can join it with local data, save to Iceberg, convert to pandas, etc.
- Federated connectors must be deployed separately before they can be queried.
- Do NOT use \`spark.read.jdbc()\` directly — use \`query_federated()\` which handles the JDBC URL, driver, and credentials automatically.
- To discover federated catalogs, do NOT use \`spark.sql("SHOW CATALOGS").collect()\`

**Data handling**
- When parsing dates, always use \`errors='coerce'\` to handle bad values: \`pd.to_datetime(df['date_col'], errors='coerce')\`
- After fitting a curve, always evaluate and report the fit quality (e.g., R², residuals).

**Scope**
- Use this tool for computation and analysis only. Do not write reports or narrative text — print the data needed for a report to the console instead.
` + (props.additionalToolDescription || ''),

    inputSchema: pysparkInputSchema,

    async *execute({ code, scriptPath, timeout = 300, description = "PySpark execution" }): AsyncGenerator<PySparkToolResult> {
        const { additionalSetupScript = '' } = props;
        const chatSessionId = getChatSessionId();
        let sessionId: string | null = null;
        if (!chatSessionId) throw new Error("Chat session ID not found");

        try {
            let codeToExecute = '';
            if (code && scriptPath) {
                codeToExecute = getPreCodeExecutionScript(code) + code + getPostCodeExecutionScript();
                await writeFileTool.handler({
                    filename: scriptPath,
                    content: getSessionSetupScript() + additionalSetupScript + '\n' + codeToExecute
                });
                console.log(`Saved code to file: ${scriptPath}`);
            } else {
                const scriptContent = await readS3File(`s3://${process.env.STORAGE_BUCKET_NAME}/${getChatSessionPrefix()}${scriptPath}`);
                codeToExecute = getPreCodeExecutionScript(scriptContent) + scriptContent;
                console.log(`Loaded code from file: ${scriptPath}`);
            }

            yield { status: 'progress', message: '🚀 Starting PySpark execution environment...' };
            const athenaClient = new AthenaClient({ region: AWS_REGION });
            yield { status: 'progress', message: '🔍 Checking for existing session...' };

            const existingSessionId = await findExistingSession(athenaClient, chatSessionId);
            if (existingSessionId) {
                const { isActive, state } = await isSessionActive(athenaClient, existingSessionId);
                if (isActive) {
                    sessionId = existingSessionId;
                    yield { status: 'progress', message: '✅ Reusing existing Athena session (faster execution)' };
                } else {
                    const stateMessage = state === 'TERMINATED' ? 'terminated' : 'no longer active';
                    yield { status: 'progress', message: `⚠️ Found existing session but it's ${stateMessage}, creating a new one...` };
                }
            }

            if (!sessionId) {
                yield { status: 'progress', message: '🔄 Creating new Athena session...' };
                const sessionToken = uuidv4();
                const startSessionCommand = new StartSessionCommand({
                    WorkGroup: getAthenaWorkgroup(),
                    Description: `Session for ${description} [ChatSessionID:${chatSessionId}]`,
                    ClientRequestToken: sessionToken,
                    EngineConfiguration: {
                        MaxConcurrentDpus: 50,
                        SparkProperties: {
                            // Iceberg catalog properties
                            "spark.sql.catalog.spark_catalog": "org.apache.iceberg.spark.SparkSessionCatalog",
                            "spark.sql.catalog.spark_catalog.catalog-impl": "org.apache.iceberg.aws.glue.GlueCatalog",
                            "spark.sql.catalog.spark_catalog.io-impl": "org.apache.iceberg.aws.s3.S3FileIO",
                            "spark.sql.extensions": "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions",
                            // Athena JDBC V2 catalog for federated query support
                            "spark.jars": `s3://${process.env.STORAGE_BUCKET_NAME}/athena-jars/AthenaJDBC.jar`,
                            "spark.sql.catalog.athena": "org.apache.spark.sql.execution.datasources.v2.jdbc.JDBCCatalog",
                            "spark.sql.catalog.athena.url": `jdbc:awsathena://athena.${AWS_REGION}.amazonaws.com:443`,
                            "spark.sql.catalog.athena.driver": "com.simba.athena.jdbc.Driver",
                            "spark.sql.catalog.athena.AwsCredentialsProviderClass": "com.simba.athena.amazonaws.auth.InstanceProfileCredentialsProvider",
                        },
                    }
                });
                console.log(`Starting Athena session in workgroup: ${getAthenaWorkgroup()}`);
                const sessionResponse = await athenaClient.send(startSessionCommand);
                if (!sessionResponse.SessionId) {
                    yield { status: 'error', message: '❌ Failed to create Athena session', output: formatResult({ error: "Failed to create Athena session", details: "No session ID was returned" }) };
                    return;
                }
                sessionId = sessionResponse.SessionId;
                console.log(`Session ID: ${sessionId}`);
                yield { status: 'progress', message: `✅ Athena session created: ${sessionId}` };

                // Wait for the session to be IDLE
                yield { status: 'progress', message: '⏳ Waiting for session to be ready...' };
                let sessionState = 'CREATING';
                let sessionAttempts = 0;
                let lastReportedPercentage = 0;
                const maxSessionAttempts = Math.ceil(timeout / 5);

                while (sessionState !== 'IDLE' && sessionState !== 'FAILED' && sessionState !== 'TERMINATED' && sessionAttempts < maxSessionAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    try {
                        const getSessionStatusResponse = await athenaClient.send(new GetSessionStatusCommand({ SessionId: sessionId }));
                        sessionState = getSessionStatusResponse.Status?.State || 'UNKNOWN';
                        const stateChangeReason = getSessionStatusResponse.Status?.StateChangeReason;
                        console.log(`Current session state: ${sessionState} (Attempt ${sessionAttempts + 1}/${maxSessionAttempts})`);
                        if (stateChangeReason) console.log(`State change reason: ${stateChangeReason}`);
                        const percentage = Math.round((sessionAttempts / maxSessionAttempts) * 100);
                        if (percentage - lastReportedPercentage >= 10) {
                            yield { status: 'progress', message: `⏳ Initializing session: ${sessionState}${stateChangeReason ? ` (${stateChangeReason})` : ''} (${percentage}%)` };
                            lastReportedPercentage = percentage;
                        }
                    } catch (error) { console.error('Error getting session status:', error); }
                    sessionAttempts++;
                }

                if (sessionState !== 'IDLE') {
                    let failureReason = '';
                    try {
                        const finalStatus = await athenaClient.send(new GetSessionStatusCommand({ SessionId: sessionId }));
                        if (finalStatus.Status?.StateChangeReason) failureReason = ` (Reason: ${finalStatus.Status.StateChangeReason})`;
                    } catch (error) { console.error('Error getting final session status:', error); }
                    yield { status: 'error', message: `❌ Session failed to reach ready state: ${sessionState}${failureReason}`, output: formatResult({ error: "Session did not reach IDLE state", state: sessionState, sessionId }) };
                    return;
                }

                yield { status: 'progress', message: `✅ Session ready! Setting up environment... (${sessionId})` };

                // Fetch session details for DPU configuration info
                let dpuInfo = '';
                try {
                    const sessionDetails = await athenaClient.send(new GetSessionCommand({ SessionId: sessionId }));
                    const engineConfig = sessionDetails.EngineConfiguration;
                    if (engineConfig) {
                        const maxDpus = engineConfig.MaxConcurrentDpus;
                        const coordSize = engineConfig.CoordinatorDpuSize ?? 1;
                        const execSize = engineConfig.DefaultExecutorDpuSize ?? 1;
                        dpuInfo = `DPUs: max=${maxDpus}, coordinator=${coordSize}, executor=${execSize}`;
                        yield { status: 'progress', message: `📊 ${dpuInfo}` };
                    }
                } catch (error) { console.error('Error fetching session details:', error); }

                let sessionSetupResult: CalculationResult | undefined;
                for await (const event of executeCalculation(
                    athenaClient, sessionId, getSessionSetupScript() + additionalSetupScript,
                    "Session Setup",
                    { timeoutSeconds: 60, waitMessage: `📚 Setting up session...`,
                      successMessage: `✅ Successfully set up session`,
                      failureMessage: `Failed to set up session`, continueOnFailure: true }
                )) {
                    if (event.type === 'progress') {
                        yield { status: 'progress', message: event.message, metrics: event.metrics };
                    } else {
                        sessionSetupResult = event;
                    }
                }

                if (!sessionSetupResult?.success) {
                    const outputs = await fetchCalculationOutputs(sessionSetupResult?.resultData);
                    yield { status: 'error', message: `❌ Setup failed: ${sessionSetupResult?.state ?? 'UNKNOWN'}`, output: formatResult({
                        status: sessionSetupResult?.state ?? 'UNKNOWN', error: "PySpark setup script execution did not complete successfully",
                        details: "Check logs for more information", output: outputs, sessionId
                    }) };
                    return;
                }
            }

            // --- Lineage: extract SQL from spark.sql() calls and parse for datasets ---
            let lineageInputs: LineageDataset[] = [];
            let lineageOutputs: LineageDataset[] = [];
            const invocationId = uuidv4();
            const lineageRunId = uuidv4();
            const domainId = process.env.DATAZONE_DOMAIN_ID ?? 'unknown';

            try {
                const sqlStatements = extractSparkSqlStatements(code);
                for (const sql of sqlStatements) {
                    const parsed = parseSqlForLineage(sql);
                    lineageInputs = lineageInputs.concat(parsed.inputs);
                    lineageOutputs = lineageOutputs.concat(parsed.outputs);
                }
            } catch (lineageError: unknown) {
                console.warn(
                    '[lineage] Failed to extract SQL from PySpark code:',
                    lineageError instanceof Error ? lineageError.message : String(lineageError),
                );
            }

            // Emit START lineage event (fire-and-forget)
            try {
                void emitLineageEvent({
                    eventType: 'START',
                    job: { namespace: domainId, name: `chat/${chatSessionId}/pyspark/${invocationId}` },
                    run: {
                        runId: lineageRunId,
                        facets: {
                            chatSession: {
                                _producer: 'https://github.com/OpenLineage/OpenLineage',
                                _schemaURL: 'https://openlineage.io/spec/2-0-0/OpenLineage.json',
                                chatSessionId,
                                source: 'pyspark',
                            },
                        },
                    },
                    inputs: lineageInputs,
                    outputs: lineageOutputs,
                });
            } catch (lineageError: unknown) {
                console.warn(
                    '[lineage] Failed to emit START event:',
                    lineageError instanceof Error ? lineageError.message : String(lineageError),
                );
            }

            // Register datasets with the session lineage tracker for session summary
            try {
                sessionLineageTracker.addDatasets(chatSessionId, [...lineageInputs, ...lineageOutputs]);
            } catch (trackerError: unknown) {
                console.warn(
                    '[lineage] Failed to register datasets with session tracker:',
                    trackerError instanceof Error ? trackerError.message : String(trackerError),
                );
            }

            const executionStartTime = Date.now();

            yield { status: 'progress', message: `✅ Submitting PySpark code for execution... (${sessionId})` };
            let codeResult: CalculationResult | undefined;
            for await (const event of executeCalculation(
                athenaClient, sessionId, codeToExecute, description,
                { timeoutSeconds: Math.ceil(timeout), waitMessage: `⏳ Executing PySpark code...`,
                  successMessage: `✅ Execution completed! Fetching results...` }
            )) {
                if (event.type === 'progress') {
                    yield { status: 'progress', message: event.message, metrics: event.metrics };
                } else {
                    codeResult = event;
                }
            }

            if (codeResult?.success) {
                // Emit COMPLETE lineage event (fire-and-forget)
                try {
                    void emitLineageEvent({
                        eventType: 'COMPLETE',
                        job: { namespace: domainId, name: `chat/${chatSessionId}/pyspark/${invocationId}` },
                        run: {
                            runId: lineageRunId,
                            facets: {
                                chatSession: {
                                    _producer: 'https://github.com/OpenLineage/OpenLineage',
                                    _schemaURL: 'https://openlineage.io/spec/2-0-0/OpenLineage.json',
                                    chatSessionId,
                                    source: 'pyspark',
                                },
                            },
                        },
                        inputs: lineageInputs,
                        outputs: lineageOutputs,
                        facets: { durationMs: Date.now() - executionStartTime },
                    });
                } catch (lineageError: unknown) {
                    console.warn(
                        '[lineage] Failed to emit COMPLETE event:',
                        lineageError instanceof Error ? lineageError.message : String(lineageError),
                    );
                }

                if (!codeResult.resultData) {
                    yield { status: 'completed', message: '⚠️ Execution completed but no output location found', output: formatResult({ status: "COMPLETED", message: "Execution completed but no output location found", sessionId }) };
                    return;
                }
                const resultWithS3 = codeResult.resultData as { StdOutS3Uri?: string };
                if (!resultWithS3.StdOutS3Uri) {
                    yield { status: 'completed', message: '⚠️ Execution completed but no output location found', output: formatResult({ status: "COMPLETED", message: "Execution completed but no output location found", sessionId }) };
                    return;
                }
                yield { status: 'progress', message: '📥 Downloading results from S3...' };
                const outputs = await fetchCalculationOutputs(codeResult.resultData);
                if (outputs.stderr?.trim()) {
                    yield { status: 'progress', message: `⚠️ Execution produced errors: ${outputs.stderr.substring(0, 100)}${outputs.stderr.length > 100 ? '...' : ''}` };
                }
                yield { status: 'completed', message: '🎉 PySpark execution completed successfully!', output: formatResult({
                    status: "COMPLETED", output: { ...outputs, message: `PySpark execution completed successfully. (Session ID: ${sessionId})` }, sessionId
                }) };
            } else {
                // Emit FAIL lineage event (fire-and-forget)
                try {
                    void emitLineageEvent({
                        eventType: 'FAIL',
                        job: { namespace: domainId, name: `chat/${chatSessionId}/pyspark/${invocationId}` },
                        run: {
                            runId: lineageRunId,
                            facets: {
                                chatSession: {
                                    _producer: 'https://github.com/OpenLineage/OpenLineage',
                                    _schemaURL: 'https://openlineage.io/spec/2-0-0/OpenLineage.json',
                                    chatSessionId,
                                    source: 'pyspark',
                                },
                            },
                        },
                        inputs: lineageInputs,
                        outputs: lineageOutputs,
                        facets: {
                            durationMs: Date.now() - executionStartTime,
                            error: codeResult?.state ?? 'UNKNOWN',
                        },
                    });
                } catch (lineageError: unknown) {
                    console.warn(
                        '[lineage] Failed to emit FAIL event:',
                        lineageError instanceof Error ? lineageError.message : String(lineageError),
                    );
                }

                const outputs = await fetchCalculationOutputs(codeResult?.resultData);
                yield { status: 'error', message: `❌ Execution failed: ${codeResult?.state ?? 'UNKNOWN'}`, output: formatResult({
                    status: codeResult?.state ?? 'UNKNOWN', error: "PySpark execution did not complete successfully",
                    details: "Check logs for more information", output: outputs, sessionId
                }) };
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            yield { status: 'error', message: `❌ Error: ${message}`, output: formatResult({
                error: `Error executing PySpark code: ${message}`, suggestion: "Check your code syntax and try again",
                sessionId: sessionId || 'Not Created'
            }) };
        }
    },
});

export const allPySparkTools = (props: { additionalSetupScript?: string; additionalToolDescription?: string } = {}) => ({
    'execute-pyspark': createPysparkTool(props),
});
