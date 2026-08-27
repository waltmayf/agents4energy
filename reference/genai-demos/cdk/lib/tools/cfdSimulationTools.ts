/**
 * CFD Simulation Tools for the AI Agent
 *
 * Provides a single tool that submits a treatment plan as a CFD simulation,
 * polls until completion, retrieves metrics, and returns a unified result
 * the agent can use to compare screen-out risk vs productivity.
 */

import { z } from 'zod';
import { getConfiguredAmplifyClient } from './amplifyUtils';

// ─── GraphQL operations ───────────────────────────────────────────────────────

const SUBMIT_MUTATION = /* GraphQL */ `
  mutation SubmitCfdSimulation($input: CfdSimulationInputInput!) {
    submitCfdSimulation(input: $input) {
      success
      simulationId
      status
      message
      error
    }
  }
`;

const STATUS_QUERY = /* GraphQL */ `
  query GetCfdJobStatus($jobId: ID!) {
    getCfdJobStatus(jobId: $jobId) {
      success
      jobId
      status
      elapsedTimeSeconds
      error
    }
  }
`;

const RESULTS_QUERY = /* GraphQL */ `
  query GetCfdResults($jobId: ID!) {
    getCfdResults(jobId: $jobId) {
      success
      jobId
      proppantPlacementEfficiency
      fractureGeometryScore
      placementUniformity
      screenOutRisk
      concentrationRisk
      velocityRisk
      pressureRisk
      confidence
      error
    }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tool: evaluate-treatment-plan ────────────────────────────────────────────

const POLL_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_S = 900; // 15 minutes

export const evaluateTreatmentPlanTool = {
  name: 'evaluate-treatment-plan',
  config: {
    title: 'Evaluate Treatment Plan',
    description:
      'Submit a hydraulic fracturing treatment plan as a full 3-D CFD simulation (pimpleFoam on HPC cluster), ' +
      'wait for completion, and return optimization and risk metrics. ' +
      'Use this to compare different pumping schedules and find the best trade-off between ' +
      'screen-out risk and well productivity. Typical runtime is 2-5 minutes.',
    inputSchema: z.object({
      planName: z.string().describe('Short label for this plan variant (e.g., "aggressive-flush", "conservative-pad")'),
      injectionRate: z.number().describe('Injection rate in m³/s (typical range 0.1–0.5)'),
      proppantConcentration: z.number().describe('Proppant volume fraction (typical range 0.1–0.4)'),
      fluidViscosity: z.number().describe('Fluid viscosity in Pa·s (typical range 0.01–0.1)'),
      treatingPressure: z.number().describe('Treating pressure in psi (typical range 3000–10000)'),
      fractureLengthM: z.number().optional().describe('Fracture half-length in meters (default 100)'),
      fractureWidthMm: z.number().optional().describe('Fracture aperture in mm (default 5)'),
      stages: z.array(z.object({
        stageType: z.enum(['pad', 'slurry', 'flush']).describe('Stage type'),
        startTimeSeconds: z.number().describe('Stage start time in seconds'),
        endTimeSeconds: z.number().describe('Stage end time in seconds'),
        pumpRateBblMin: z.number().describe('Pump rate in barrels per minute'),
        proppantConcentrationPpg: z.number().describe('Proppant concentration in pounds per gallon'),
        fluidViscosityCp: z.number().describe('Fluid viscosity in centipoise'),
      })).describe('Pumping schedule stages (pad → slurry → flush)'),
      timeoutSeconds: z.number().optional().describe('Max wait time in seconds (default 900)'),
    }),
  },
  handler: async (params: {
    planName: string;
    injectionRate: number;
    proppantConcentration: number;
    fluidViscosity: number;
    treatingPressure: number;
    fractureLengthM?: number;
    fractureWidthMm?: number;
    stages: Array<{
      stageType: 'pad' | 'slurry' | 'flush';
      startTimeSeconds: number;
      endTimeSeconds: number;
      pumpRateBblMin: number;
      proppantConcentrationPpg: number;
      fluidViscosityCp: number;
    }>;
    timeoutSeconds?: number;
  }) => {
    const client = getConfiguredAmplifyClient();
    const timeout = (params.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;
    const startTime = Date.now();

    try {
      // ── Step 1: Build pumping schedule and submit ─────────────────────────
      const totalDuration = Math.max(...params.stages.map(s => s.endTimeSeconds));
      const pumpingSchedule = {
        totalDurationSeconds: totalDuration,
        stages: params.stages,
      };

      const operationId = `plan-${params.planName}-${Date.now()}`;

      const submitResult = await client.graphql({
        query: SUBMIT_MUTATION,
        variables: {
          input: {
            operationId,
            simulationType: 'oneshot',
            injectionRate: params.injectionRate,
            proppantConcentration: params.proppantConcentration,
            fluidViscosity: params.fluidViscosity,
            treatingPressure: params.treatingPressure,
            fractureLengthM: params.fractureLengthM ?? 100,
            fractureWidthMm: params.fractureWidthMm ?? 5,
            pumpingSchedule: JSON.stringify(pumpingSchedule),
          },
        },
      }, { authMode: 'userPool' });

      const submitData = ('data' in submitResult ? submitResult.data : null) as Record<string, any> | null;
      const submission = submitData?.submitCfdSimulation;

      if (!submission?.success || !submission.simulationId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              planName: params.planName,
              error: submission?.error ?? 'Submission failed',
            }, null, 2),
          }],
          isError: true,
        };
      }

      const simulationId = submission.simulationId as string;

      // ── Step 2: Poll until completed or failed ────────────────────────────
      let finalStatus = 'PENDING';

      while (Date.now() - startTime < timeout) {
        await sleep(POLL_INTERVAL_MS);

        const statusResult = await client.graphql({
          query: STATUS_QUERY,
          variables: { jobId: simulationId },
        }, { authMode: 'userPool' });

        const statusData = ('data' in statusResult ? statusResult.data : null) as Record<string, any> | null;
        const status = statusData?.getCfdJobStatus;

        if (!status?.success) continue;

        finalStatus = status.status as string;

        if (finalStatus === 'COMPLETED') break;
        if (finalStatus === 'FAILED') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                planName: params.planName,
                simulationId,
                status: 'FAILED',
                error: status.error ?? 'Simulation failed on cluster',
                elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
              }, null, 2),
            }],
            isError: true,
          };
        }
      }

      if (finalStatus !== 'COMPLETED') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              planName: params.planName,
              simulationId,
              status: finalStatus,
              error: `Timed out after ${Math.round(timeout / 1000)}s`,
            }, null, 2),
          }],
          isError: true,
        };
      }

      // ── Step 3: Retrieve metrics ──────────────────────────────────────────
      const resultsResult = await client.graphql({
        query: RESULTS_QUERY,
        variables: { jobId: simulationId },
      }, { authMode: 'userPool' });

      const resultsData = ('data' in resultsResult ? resultsResult.data : null) as Record<string, any> | null;
      const metrics = resultsData?.getCfdResults;

      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);

      if (!metrics?.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              planName: params.planName,
              simulationId,
              status: 'COMPLETED',
              error: metrics?.error ?? 'Failed to retrieve metrics',
              elapsedSeconds,
            }, null, 2),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            planName: params.planName,
            simulationId,
            elapsedSeconds,
            metrics: {
              proppantPlacementEfficiency: metrics.proppantPlacementEfficiency,
              fractureGeometryScore: metrics.fractureGeometryScore,
              placementUniformity: metrics.placementUniformity,
              screenOutRisk: metrics.screenOutRisk,
              concentrationRisk: metrics.concentrationRisk,
              velocityRisk: metrics.velocityRisk,
              pressureRisk: metrics.pressureRisk,
              confidence: metrics.confidence,
            },
            pumpingSchedule: {
              totalDurationSeconds: totalDuration,
              stageCount: params.stages.length,
              stages: params.stages.map(s => ({
                type: s.stageType,
                duration: s.endTimeSeconds - s.startTimeSeconds,
                pumpRate: s.pumpRateBblMin,
                proppant: s.proppantConcentrationPpg,
              })),
            },
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: false,
            planName: params.planName,
            error: error instanceof Error ? error.message : String(error),
            elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
          }, null, 2),
        }],
        isError: true,
      };
    }
  },
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const allCfdSimulationTools = [
  evaluateTreatmentPlanTool,
];
