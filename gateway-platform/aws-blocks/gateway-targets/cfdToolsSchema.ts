import { SchemaType, type ToolDefinition } from '@aws-sdk/client-bedrock-agentcore-control';

// MCP tool schema for the cfd-tools gateway target (issue #504) — moved
// verbatim from web/amplify/constructs/cfdToolsGatewayTarget/handler.ts as
// part of #536. The Lambda implementing these tools is a local copy at
// ./cfd-tools/handler.ts (see its header comment for why).
const STAGE_SCHEMA = {
  type: SchemaType.OBJECT,
  description: 'One stage of the pumping schedule.',
  properties: {
    stageType: { type: SchemaType.STRING, description: 'One of "pad", "slurry", "flush".' },
    startTimeSeconds: { type: SchemaType.NUMBER, description: 'Stage start time in seconds.' },
    endTimeSeconds: { type: SchemaType.NUMBER, description: 'Stage end time in seconds. Must equal the next stage\'s startTimeSeconds.' },
    pumpRateBblMin: { type: SchemaType.NUMBER, description: 'Pump rate in barrels per minute (must be > 0).' },
    proppantConcentrationPpg: { type: SchemaType.NUMBER, description: 'Proppant concentration in pounds per gallon (must be >= 0).' },
    fluidViscosityCp: { type: SchemaType.NUMBER, description: 'Fluid viscosity in centipoise (must be > 0).' },
  },
  required: ['stageType', 'startTimeSeconds', 'endTimeSeconds', 'pumpRateBblMin', 'proppantConcentrationPpg', 'fluidViscosityCp'],
};

const TREATMENT_PLAN_PROPERTIES = {
  injectionRate: { type: SchemaType.NUMBER, description: 'Injection rate in m³/s (valid range 0.1-0.5).' },
  proppantConcentration: { type: SchemaType.NUMBER, description: 'Proppant volume fraction (valid range 0.1-0.4).' },
  fluidViscosity: { type: SchemaType.NUMBER, description: 'Fluid viscosity in Pa·s (valid range 0.01-0.1).' },
  treatingPressure: { type: SchemaType.NUMBER, description: 'Treating pressure in psi (must be > 0).' },
  fractureLengthM: { type: SchemaType.NUMBER, description: 'Fracture half-length in meters. Defaults to 100.' },
  fractureWidthMm: { type: SchemaType.NUMBER, description: 'Fracture aperture in mm. Defaults to 5.' },
  stages: {
    type: SchemaType.ARRAY,
    description:
      'Pumping schedule stages (pad -> slurry -> flush), contiguous in time. When provided, the simulation runs '
      + 'a transient pimpleFoam solve with a time-varying inlet from the schedule; when omitted, it runs a steady-state simpleFoam solve.',
    items: STAGE_SCHEMA,
  },
};

export const cfdToolsToolDefinitions: ToolDefinition[] = [
  {
    name: 'SubmitCfdSimulation',
    description:
      'Submit a hydraulic fracturing treatment plan as a CFD simulation (simpleFoam or pimpleFoam) to the HPC '
      + 'cluster via Slurm. Returns the Slurm job id — poll with GetCfdJobStatus, then fetch metrics with GetCfdResults.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        planName: { type: SchemaType.STRING, description: 'Short label for this plan variant (e.g. "aggressive-flush").' },
        ...TREATMENT_PLAN_PROPERTIES,
      },
      required: ['injectionRate', 'proppantConcentration', 'fluidViscosity', 'treatingPressure'],
    },
  },
  {
    name: 'GetCfdJobStatus',
    description: 'Poll a submitted CFD simulation\'s Slurm job status (PENDING, RUNNING, COMPLETED, FAILED, or CANCELLED).',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'The Slurm job id returned by SubmitCfdSimulation.' },
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
      type: SchemaType.OBJECT,
      properties: {
        jobId: { type: SchemaType.STRING, description: 'The Slurm job id returned by SubmitCfdSimulation.' },
      },
      required: ['jobId'],
    },
  },
];
