/**
 * Tool definitions for the cfd-tools Lambda target (issue #504, migrated to
 * gateway-platform by #549, 2/4 of #536). Ported from web/amplify/constructs/
 * cfdToolsGatewayTarget/handler.ts's `toolDefinitions()`, translated from the
 * `@aws-sdk/client-bedrock-agentcore-control` SDK's `SchemaType` enum to
 * aws-cdk-lib's own `SchemaDefinitionType` (this app declares the target via
 * the native `GatewayTarget.forLambda` L2 + `ToolSchema.fromInline`, not a
 * raw SDK `CreateGatewayTargetCommand` call) — same translation s3-tools'
 * tool-schema.ts did in #548.
 */
import { SchemaDefinitionType, type ToolDefinition } from 'aws-cdk-lib/aws-bedrockagentcore';

const STAGE_SCHEMA = {
  type: SchemaDefinitionType.OBJECT,
  description: 'One stage of the pumping schedule.',
  properties: {
    stageType: { type: SchemaDefinitionType.STRING, description: 'One of "pad", "slurry", "flush".' },
    startTimeSeconds: { type: SchemaDefinitionType.NUMBER, description: 'Stage start time in seconds.' },
    endTimeSeconds: { type: SchemaDefinitionType.NUMBER, description: 'Stage end time in seconds. Must equal the next stage\'s startTimeSeconds.' },
    pumpRateBblMin: { type: SchemaDefinitionType.NUMBER, description: 'Pump rate in barrels per minute (must be > 0).' },
    proppantConcentrationPpg: { type: SchemaDefinitionType.NUMBER, description: 'Proppant concentration in pounds per gallon (must be >= 0).' },
    fluidViscosityCp: { type: SchemaDefinitionType.NUMBER, description: 'Fluid viscosity in centipoise (must be > 0).' },
  },
  required: ['stageType', 'startTimeSeconds', 'endTimeSeconds', 'pumpRateBblMin', 'proppantConcentrationPpg', 'fluidViscosityCp'],
};

const TREATMENT_PLAN_PROPERTIES = {
  injectionRate: { type: SchemaDefinitionType.NUMBER, description: 'Injection rate in m³/s (valid range 0.1-0.5).' },
  proppantConcentration: { type: SchemaDefinitionType.NUMBER, description: 'Proppant volume fraction (valid range 0.1-0.4).' },
  fluidViscosity: { type: SchemaDefinitionType.NUMBER, description: 'Fluid viscosity in Pa·s (valid range 0.01-0.1).' },
  treatingPressure: { type: SchemaDefinitionType.NUMBER, description: 'Treating pressure in psi (must be > 0).' },
  fractureLengthM: { type: SchemaDefinitionType.NUMBER, description: 'Fracture half-length in meters. Defaults to 100.' },
  fractureWidthMm: { type: SchemaDefinitionType.NUMBER, description: 'Fracture aperture in mm. Defaults to 5.' },
  stages: {
    type: SchemaDefinitionType.ARRAY,
    description:
      'Pumping schedule stages (pad -> slurry -> flush), contiguous in time. When provided, the simulation runs '
      + 'a transient pimpleFoam solve with a time-varying inlet from the schedule; when omitted, it runs a steady-state simpleFoam solve.',
    items: STAGE_SCHEMA,
  },
};

export const CFD_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'SubmitCfdSimulation',
    description:
      'Submit a hydraulic fracturing treatment plan as a CFD simulation (simpleFoam or pimpleFoam) to the HPC '
      + 'cluster via Slurm. Returns the Slurm job id — poll with GetCfdJobStatus, then fetch metrics with GetCfdResults.',
    inputSchema: {
      type: SchemaDefinitionType.OBJECT,
      properties: {
        planName: { type: SchemaDefinitionType.STRING, description: 'Short label for this plan variant (e.g. "aggressive-flush").' },
        ...TREATMENT_PLAN_PROPERTIES,
      },
      required: ['injectionRate', 'proppantConcentration', 'fluidViscosity', 'treatingPressure'],
    },
  },
  {
    name: 'GetCfdJobStatus',
    description: 'Poll a submitted CFD simulation\'s Slurm job status (PENDING, RUNNING, COMPLETED, FAILED, or CANCELLED).',
    inputSchema: {
      type: SchemaDefinitionType.OBJECT,
      properties: {
        jobId: { type: SchemaDefinitionType.STRING, description: 'The Slurm job id returned by SubmitCfdSimulation.' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'GetCfdResults',
    description:
      'Retrieve optimization/risk metrics for a COMPLETED CFD simulation (proppant placement efficiency, fracture '
      + 'geometry score, screen-out risk, etc.), copied from FSx to S3 by the cluster.',
    inputSchema: {
      type: SchemaDefinitionType.OBJECT,
      properties: {
        jobId: { type: SchemaDefinitionType.STRING, description: 'The Slurm job id returned by SubmitCfdSimulation.' },
      },
      required: ['jobId'],
    },
  },
];
