/**
 * Screen-Out Prediction Tools for the AI Agent
 *
 * Provides tools for:
 * - Starting / querying well operations
 * - Submitting real-time sensor readings for risk assessment
 * - Retrieving prediction history and CFD validation status
 */

import { z } from 'zod';
import { getConfiguredAmplifyClient } from './amplifyUtils';

// ─── GraphQL fragments ────────────────────────────────────────────────────────

const WELL_OPERATION_FIELDS = /* GraphQL */ `
  id wellName wellId fieldName operatorName status
  targetDepth lateralLength numberOfStages currentStage
  dailyOperatingCost screenOutCostEstimate
  plannedStartDate actualStartDate completedAt
  currentRiskLevel currentRiskScore lastRiskAssessmentAt
  clusterStatus clusterStartedAt notes
  createdAt updatedAt
`;

const SCREEN_OUT_PREDICTION_FIELDS = /* GraphQL */ `
  id operationId
  tier1RiskScore tier1RiskLevel tier1ComputeMs
  tier2RiskScore tier2RiskLevel tier2Triggered
  tier3Triggered cfdJobId tier3RiskScore
  finalRiskLevel finalRiskScore finalConfidence predictionTier
  alertSent assessedAt totalComputeMs
  actualScreenOutOccurred feedbackNotes
  physicsIndicators {
    settlingVelocity criticalTransportVelocity velocityRatio
    concentrationRisk pressureGradientRisk bridgingProbability
    combinedRiskScore estimatedTimeToScreenOut
  }
  romAnalysis {
    screenOutRisk proppantPackConcentration minFluidVelocity
    criticalZoneLocation timeToScreenOut confidence
    computationTimeMs recommendedAction
  }
  recommendation {
    action description targetPumpRate targetProppantConc
    urgency expectedRiskReduction
  }
  sensorData {
    treatingPressure pumpRate proppantConcentration fluidViscosity
    proppantMeshSize temperature timestamp
  }
`;

const mutations = {
  assessScreenOutRisk: /* GraphQL */ `
    mutation AssessScreenOutRisk($input: AWSJSON!) {
      assessScreenOutRisk(input: $input)
    }
  `,
  startWellOperation: /* GraphQL */ `
    mutation StartWellOperation($input: AWSJSON!) {
      startWellOperation(input: $input)
    }
  `,
};

const queries = {
  getLatestScreenOutPrediction: /* GraphQL */ `
    query GetLatestScreenOutPrediction($operationId: String!) {
      getLatestScreenOutPrediction(operationId: $operationId)
    }
  `,
  listWellOperations: /* GraphQL */ `
    query ListWellOperations($limit: Int, $nextToken: String) {
      listWellOperations(limit: $limit, nextToken: $nextToken) {
        items { ${WELL_OPERATION_FIELDS} }
        nextToken
      }
    }
  `,
  getWellOperation: /* GraphQL */ `
    query GetWellOperation($id: ID!) {
      getWellOperation(id: $id) { ${WELL_OPERATION_FIELDS} }
    }
  `,
  predictionsByOperation: /* GraphQL */ `
    query PredictionsByOperationAndTime(
      $operationId: ID!
      $sortDirection: ModelSortDirection
      $limit: Int
    ) {
      predictionsByOperationAndTime(
        operationId: $operationId
        sortDirection: $sortDirection
        limit: $limit
      ) {
        items { ${SCREEN_OUT_PREDICTION_FIELDS} }
        nextToken
      }
    }
  `,
  listCfdValidationJobs: /* GraphQL */ `
    query ListCfdValidationJobs($limit: Int) {
      listCfdValidationJobs(limit: $limit) {
        items {
          id operationId predictionId cfdSimulationId
          injectionRate proppantConcentration fluidViscosity treatingPressure
          status screenOutRisk timeToScreenOutSeconds validationSummary
          triggeredAt completedAt
        }
      }
    }
  `,
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function parseGraphqlJson(raw: any): any {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

// ─── Tool: start-well-operation ───────────────────────────────────────────────

export const startWellOperationTool = {
  name: 'start-well-operation',
  config: {
    title: 'Start Well Operation',
    description:
      'Register a new hydraulic fracturing operation for real-time screen-out monitoring. ' +
      'Returns the operationId needed for subsequent sensor readings and risk assessments.',
    inputSchema: z.object({
      wellName: z.string().describe('Well name / identifier (e.g., "Wolfcamp 12H")'),
      wellId: z.string().optional().describe('External well ID from SCADA or DAS system'),
      fieldName: z.string().optional().describe('Field or pad name'),
      operatorName: z.string().optional().describe('Operator company name'),
      targetDepth: z.number().optional().describe('Total vertical depth in feet'),
      lateralLength: z.number().optional().describe('Lateral length in feet'),
      numberOfStages: z.number().optional().describe('Total number of frac stages planned'),
      dailyOperatingCost: z.number().optional().describe('Daily operating cost in USD (default $100k)'),
      screenOutCostEstimate: z.number().optional().describe('Estimated cost per screen-out event in USD (default $750k)'),
      notes: z.string().optional().describe('Additional operational notes'),
    }),
  },
  handler: async (params: any) => {
    try {
      const client = getConfiguredAmplifyClient();
      const result = await client.graphql({
        query: mutations.startWellOperation,
        variables: { input: JSON.stringify(params) },
      }, { authMode: 'userPool' });

      const data = 'data' in result ? result.data : null;
      const response = parseGraphqlJson((data as any)?.startWellOperation);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        isError: true,
      };
    }
  },
};

// ─── Tool: assess-screen-out-risk ─────────────────────────────────────────────

export const assessScreenOutRiskTool = {
  name: 'assess-screen-out-risk',
  config: {
    title: 'Assess Screen-Out Risk',
    description:
      'Submit real-time wellhead sensor data and receive an instant tiered screen-out risk assessment. ' +
      'Tier 1 (physics, <1s) always runs. Tier 2 (ROM surrogate, <30s) runs when risk > 30%. ' +
      'Tier 3 (full CFD on Parallel Cluster) is automatically triggered when risk > 70%. ' +
      'Returns risk level (low/medium/high/critical), risk score 0–1, and operator recommendations.',
    inputSchema: z.object({
      operationId: z.string().describe('WellOperation ID from start-well-operation'),
      sensorData: z.object({
        treatingPressure: z.number().describe('Surface treating pressure in psi'),
        pumpRate: z.number().describe('Slurry pump rate in bbl/min'),
        proppantConcentration: z.number().describe('Proppant concentration in ppg (pounds per gallon added)'),
        fluidViscosity: z.number().describe('Apparent fluid viscosity in cP'),
        proppantMeshSize: z.string().optional().describe('Proppant mesh size e.g. "40/70", "30/50", "20/40"'),
        temperature: z.number().optional().describe('Bottomhole temperature in °F'),
        bottomholePressure: z.number().optional().describe('Bottomhole pressure in psi (if BHTP available)'),
        pressureDerivative: z.number().optional().describe('Rate of pressure change dP/dt in psi/min (positive = increasing)'),
        timestamp: z.string().optional().describe('ISO timestamp of reading (defaults to now)'),
      }),
    }),
  },
  handler: async (params: any) => {
    try {
      const client = getConfiguredAmplifyClient();
      const result = await client.graphql({
        query: mutations.assessScreenOutRisk,
        variables: { input: JSON.stringify(params) },
      }, { authMode: 'userPool' });

      const data = 'data' in result ? result.data : null;
      const response = parseGraphqlJson((data as any)?.assessScreenOutRisk);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        isError: true,
      };
    }
  },
};

// ─── Tool: get-latest-screen-out-prediction ───────────────────────────────────

export const getLatestPredictionTool = {
  name: 'get-latest-screen-out-prediction',
  config: {
    title: 'Get Latest Screen-Out Prediction',
    description: 'Retrieve the most recent screen-out risk prediction for a well operation, including risk scores from all tiers and the mitigation recommendation.',
    inputSchema: z.object({
      operationId: z.string().describe('WellOperation ID'),
    }),
  },
  handler: async (params: any) => {
    try {
      const client = getConfiguredAmplifyClient();
      const result = await client.graphql({
        query: queries.getLatestScreenOutPrediction,
        variables: { operationId: params.operationId },
      }, { authMode: 'userPool' });

      const data = 'data' in result ? result.data : null;
      const response = parseGraphqlJson((data as any)?.getLatestScreenOutPrediction);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        isError: true,
      };
    }
  },
};

// ─── Tool: list-well-operations ───────────────────────────────────────────────

export const listWellOperationsTool = {
  name: 'list-well-operations',
  config: {
    title: 'List Well Operations',
    description: 'List all hydraulic fracturing well operations with their current screen-out risk status.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Maximum number of operations to return (default 50)'),
    }),
  },
  handler: async (params: any) => {
    try {
      const client = getConfiguredAmplifyClient();
      const result = await client.graphql({
        query: queries.listWellOperations,
        variables: { limit: params.limit || 50 },
      }, { authMode: 'userPool' });

      const data = 'data' in result ? result.data : null;
      const items = (data as any)?.listWellOperations?.items ?? [];

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, operations: items, count: items.length }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        isError: true,
      };
    }
  },
};

// ─── Tool: get-prediction-history ────────────────────────────────────────────

export const getPredictionHistoryTool = {
  name: 'get-prediction-history',
  config: {
    title: 'Get Prediction History',
    description: 'Retrieve the historical screen-out risk predictions for a well operation, sorted by time. Useful for trend analysis and post-job reviews.',
    inputSchema: z.object({
      operationId: z.string().describe('WellOperation ID'),
      limit: z.number().optional().describe('Number of predictions to return (default 20, max 100)'),
      sortDirection: z.enum(['ASC', 'DESC']).optional().describe('Sort order by time (default DESC = newest first)'),
    }),
  },
  handler: async (params: any) => {
    try {
      const client = getConfiguredAmplifyClient();
      const result = await client.graphql({
        query: queries.predictionsByOperation,
        variables: {
          operationId: params.operationId,
          sortDirection: params.sortDirection || 'DESC',
          limit: Math.min(params.limit || 20, 100),
        },
      }, { authMode: 'userPool' });

      const data = 'data' in result ? result.data : null;
      const items = (data as any)?.predictionsByOperationAndTime?.items ?? [];

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, predictions: items, count: items.length }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        isError: true,
      };
    }
  },
};

// ─── Tool: list-cfd-validation-jobs ──────────────────────────────────────────

export const listCfdValidationJobsTool = {
  name: 'list-cfd-validation-jobs',
  config: {
    title: 'List CFD Validation Jobs',
    description: 'List full CFD simulations that were triggered by high screen-out risk predictions (Tier 3). Shows status of each Parallel Cluster job and any completed risk results.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Maximum number of jobs to return (default 20)'),
    }),
  },
  handler: async (params: any) => {
    try {
      const client = getConfiguredAmplifyClient();
      const result = await client.graphql({
        query: queries.listCfdValidationJobs,
        variables: { limit: params.limit || 20 },
      }, { authMode: 'userPool' });

      const data = 'data' in result ? result.data : null;
      const items = (data as any)?.listCfdValidationJobs?.items ?? [];

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, jobs: items, count: items.length }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
        isError: true,
      };
    }
  },
};

// ─── Export ───────────────────────────────────────────────────────────────────

export const allScreenOutTools = [
  startWellOperationTool,
  assessScreenOutRiskTool,
  getLatestPredictionTool,
  listWellOperationsTool,
  getPredictionHistoryTool,
  listCfdValidationJobsTool,
];
