/**
 * Fracture Interpretation Tools for the AI Agent
 *
 * Three tools that implement the ensemble-based geological interpretation loop:
 *
 * 1. run-ensemble-simulation    — Submit all 10 scenario simulations from a base plan
 * 2. interpret-pressure-response — Match a measured/drawn curve to the ensemble
 * 3. run-hypothesis-simulations  — One iteration of the adaptive investigation loop
 */

import { z } from 'zod';
import { getConfiguredAmplifyClient } from './amplifyUtils';

// ─── Shared GraphQL ────────────────────────────────────────────────────────────

const RUN_ENSEMBLE_MUTATION = /* GraphQL */ `
  mutation RunEnsembleSimulation($input: AWSJSON!) {
    runEnsembleSimulation(input: $input)
  }
`;

const INTERPRET_MUTATION = /* GraphQL */ `
  mutation InterpretPressureResponse($input: AWSJSON!) {
    interpretPressureResponse(input: $input)
  }
`;

const RUN_HYPOTHESIS_MUTATION = /* GraphQL */ `
  mutation RunHypothesisSimulations($input: AWSJSON!) {
    runHypothesisSimulations(input: $input)
  }
`;

// ─── Tool 1: run-ensemble-simulation ─────────────────────────────────────────

export const runEnsembleSimulationTool = {
  name: 'run-ensemble-simulation',
  config: {
    title: 'Run Ensemble Simulation',
    description:
      'Submit a base treatment plan as 10 concurrent CFD simulations — one per geological scenario archetype ' +
      '(Tight Homogeneous, Naturally Fractured, Stress Barrier, Soft/Ductile, High Leak-off, Near-wellbore Tortuosity, ' +
      'Over-pressured Zone, Screen-out Prone, Multi-layer, Ideal Formation). ' +
      'Returns an ensembleRunId. The simulations run asynchronously on the HPC cluster. ' +
      'Use this before a fracturing job starts to pre-generate the pressure response library.',
    inputSchema: z.object({
      name: z.string().describe('Label for this ensemble run, e.g. "Well A-15 Stage 3 Pre-job"'),
      wellId: z.string().optional().describe('Well identifier'),
      injectionRate: z.number().describe('Base injection rate in m³/s'),
      proppantConcentration: z.number().describe('Base proppant volume fraction (0.1–0.4)'),
      fluidViscosity: z.number().describe('Base fluid viscosity in Pa·s'),
      treatingPressure: z.number().describe('Expected treating pressure in psi'),
      fractureLengthM: z.number().optional().describe('Fracture half-length in meters (default 100)'),
      fractureWidthMm: z.number().optional().describe('Fracture aperture in mm (default 5)'),
    }),
  },
  handler: async (params: {
    name: string;
    wellId?: string;
    injectionRate: number;
    proppantConcentration: number;
    fluidViscosity: number;
    treatingPressure: number;
    fractureLengthM?: number;
    fractureWidthMm?: number;
  }) => {
    const client = getConfiguredAmplifyClient();
    try {
      const result = await client.graphql({
        query: RUN_ENSEMBLE_MUTATION,
        variables: {
          input: JSON.stringify({
            wellId: params.wellId ?? 'unknown',
            name: params.name,
            baseTreatmentPlan: {
              injectionRate: params.injectionRate,
              proppantConcentration: params.proppantConcentration,
              fluidViscosity: params.fluidViscosity,
              treatingPressure: params.treatingPressure,
              fractureLengthM: params.fractureLengthM,
              fractureWidthMm: params.fractureWidthMm,
            },
          }),
        },
      }, { authMode: 'userPool' });

      const raw = (result as any)?.data?.runEnsembleSimulation;
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        isError: !data?.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }, null, 2) }],
        isError: true,
      };
    }
  },
};

// ─── Tool 2: interpret-pressure-response ─────────────────────────────────────

export const interpretPressureResponseTool = {
  name: 'interpret-pressure-response',
  config: {
    title: 'Interpret Pressure Response',
    description:
      'Match a measured or hand-drawn wellbore pressure response against the 10-scenario ensemble using ' +
      'diagnostic feature extraction (Nolte-Smith slope, early-time rise rate, step-change count, leak-off rate, ISIP). ' +
      'Returns ranked geological scenario matches with confidence scores and a specific treatment recommendation. ' +
      'Also returns a residual vector and whether the adaptive investigation loop is recommended for higher confidence.',
    inputSchema: z.object({
      pressureTimeSeries: z.array(z.object({
        t: z.number().describe('Time in seconds'),
        p: z.number().describe('Treating pressure in psi'),
      })).describe('Pressure-vs-time data points (measured or drawn)'),
      pumpRateBblMin: z.number().describe('Average pump rate in bbl/min'),
      totalVolumePumped: z.number().describe('Total fluid volume pumped in barrels'),
      currentStage: z.number().describe('Current fracturing stage number'),
      breakdownPsi: z.number().optional().describe('Surface breakdown pressure in psi (default 8500)'),
      ensembleRunId: z.string().optional().describe('ID of a pre-run ensemble to compare against'),
    }),
  },
  handler: async (params: {
    pressureTimeSeries: Array<{ t: number; p: number }>;
    pumpRateBblMin: number;
    totalVolumePumped: number;
    currentStage: number;
    breakdownPsi?: number;
    ensembleRunId?: string;
  }) => {
    const client = getConfiguredAmplifyClient();
    try {
      const result = await client.graphql({
        query: INTERPRET_MUTATION,
        variables: { input: JSON.stringify(params) },
      }, { authMode: 'userPool' });

      const raw = (result as any)?.data?.interpretPressureResponse;
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        isError: !data?.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }, null, 2) }],
        isError: true,
      };
    }
  },
};

// ─── Tool 3: run-hypothesis-simulations ──────────────────────────────────────

export const runHypothesisSimulationsTool = {
  name: 'run-hypothesis-simulations',
  config: {
    title: 'Run Hypothesis Simulations (Adaptive Investigation Loop)',
    description:
      'Submit targeted CFD simulations to test specific geological hypotheses derived from residual analysis. ' +
      'Each hypothesis modifies one or two formation parameters of a base scenario to better explain the ' +
      'measured pressure response. Returns residual RMS for each hypothesis and the best-fitting parameter set. ' +
      'Call this iteratively (up to 4 times) when interpret-pressure-response returns adaptiveLoopRecommended=true. ' +
      'Stop when convergenceAchieved=true or nextIterationRecommended=false. ' +
      'The inferred formation parameters from the converged result are used to generate more precise recommendations.',
    inputSchema: z.object({
      investigationSessionId: z.string().describe('ID to group iterations (create a UUID on first call, reuse on subsequent calls)'),
      iterationNumber: z.number().describe('Iteration counter starting at 1'),
      hypotheses: z.array(z.object({
        id: z.string().describe('Short hypothesis ID, e.g. "H1"'),
        description: z.string().describe('Human-readable description of what is being tested'),
        rationale: z.string().describe('Why this hypothesis might explain the residual'),
        baseScenarioId: z.string().describe('Base scenario to modify (S01–S10)'),
        parameterDeltas: z.object({
          youngModulusMmpsi: z.number().optional().describe('Delta to Young\'s Modulus in MMpsi'),
          permeabilityMd: z.number().optional().describe('Delta to permeability in mD'),
          naturalFractureDensity: z.number().optional().describe('Delta to NF density (0–1)'),
          stressContrastPsi: z.number().optional().describe('Delta to stress contrast in psi'),
          tortuosityFactor: z.number().optional().describe('Delta to tortuosity factor (0–1)'),
          poissonRatio: z.number().optional().describe('Delta to Poisson ratio'),
          porePressureGradient: z.number().optional().describe('Delta to pore pressure gradient in psi/ft'),
        }).describe('Formation parameter changes relative to base scenario'),
      })).describe('List of 2–4 hypotheses to test in parallel'),
      baseTreatmentPlan: z.object({
        injectionRate: z.number(),
        proppantConcentration: z.number(),
        fluidViscosity: z.number(),
        treatingPressure: z.number(),
        fractureLengthM: z.number().optional(),
        fractureWidthMm: z.number().optional(),
      }).describe('Treatment plan parameters (same as used for ensemble)'),
      measuredCurve: z.array(z.object({
        t: z.number(),
        p: z.number(),
      })).describe('The measured pressure curve to match against'),
      previousBestResidualRMS: z.number().describe('RMS residual from previous iteration (use 9999 on first call)'),
      maxWaitSeconds: z.number().optional().describe('Max seconds to wait for simulations (default 480)'),
    }),
  },
  handler: async (params: {
    investigationSessionId: string;
    iterationNumber: number;
    hypotheses: Array<{
      id: string;
      description: string;
      rationale: string;
      baseScenarioId: string;
      parameterDeltas: Record<string, number>;
    }>;
    baseTreatmentPlan: {
      injectionRate: number;
      proppantConcentration: number;
      fluidViscosity: number;
      treatingPressure: number;
      fractureLengthM?: number;
      fractureWidthMm?: number;
    };
    measuredCurve: Array<{ t: number; p: number }>;
    previousBestResidualRMS: number;
    maxWaitSeconds?: number;
  }) => {
    const client = getConfiguredAmplifyClient();
    try {
      const result = await client.graphql({
        query: RUN_HYPOTHESIS_MUTATION,
        variables: { input: JSON.stringify(params) },
      }, { authMode: 'userPool' });

      const raw = (result as any)?.data?.runHypothesisSimulations;
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        isError: !data?.success,
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }, null, 2) }],
        isError: true,
      };
    }
  },
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const allFractureInterpretationTools = [
  runEnsembleSimulationTool,
  interpretPressureResponseTool,
  runHypothesisSimulationsTool,
];
