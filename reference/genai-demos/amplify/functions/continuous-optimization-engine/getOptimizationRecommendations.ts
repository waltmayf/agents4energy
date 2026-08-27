/**
 * Get Optimization Recommendations Handler
 * 
 * Retrieves optimization recommendations for a session:
 * 1. Queries OptimizationRecommendation records by sessionId
 * 2. Sorts by priority (CRITICAL, HIGH, MEDIUM, LOW) and timestamp
 * 3. Returns recommendations with all details
 * 
 * Requirements: 10.1, 10.5
 */

import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { type DataClientEnv } from '@aws-amplify/backend-function/runtime';
import { env } from '$amplify/env/get-optimization-recommendations';
import { withRetry, classifyError, logError, ErrorCategory, ErrorCode, ClassifiedError } from '../shared/utils/errorHandler';
import { 
  publishOptimizationIterationTime, 
  publishErrorRate,
  ErrorCategory as MetricsErrorCategory,
  MetricDimensions,
} from '../shared/utils/metricsPublisher';

// Constants
const COMPONENT_NAME = 'GetOptimizationRecommendations';

// Priority order for sorting (higher number = higher priority)
const PRIORITY_ORDER: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

/**
 * Handler for getOptimizationRecommendations query
 */
export const handler: Schema['getOptimizationRecommendations']['functionHandler'] = async (event) => {
  console.log('Getting optimization recommendations', JSON.stringify(event, null, 2));

  // Configure Amplify client using official Gen 2 pattern
  // Note: env type will include AMPLIFY_DATA_DEFAULT_NAME after deployment regenerates types
  const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env as unknown as DataClientEnv);
  Amplify.configure(resourceConfig, libraryOptions);
  const client = generateClient<Schema>();

  const startTime = Date.now();
  const { sessionId } = event.arguments;

  const dimensions: MetricDimensions = {
    FunctionName: 'getOptimizationRecommendations',
    SessionId: sessionId,
  };

  try {
    // ========================================================================
    // Step 1: Validate session exists
    // ========================================================================
    console.log(`Validating optimization session ${sessionId}`);
    
    const sessionResult = await withRetry({
      operation: async () => {
        const result = await client.models.OptimizationSession.get({ id: sessionId });
        if (!result.data) {
          throw new ClassifiedError(
            ErrorCategory.PERMANENT,
            ErrorCode.INVALID_PARAMETERS,
            `Optimization session ${sessionId} not found`,
            { sessionId }
          );
        }
        return result.data;
      },
      operationName: 'GetOptimizationSession',
      component: COMPONENT_NAME,
      context: { sessionId },
    });

    console.log(`Session ${sessionId} found with status: ${sessionResult.status}`);

    // ========================================================================
    // Step 2: Query OptimizationRecommendation records by sessionId
    // ========================================================================
    console.log('Querying recommendations for session');
    
    const recommendationsResult = await withRetry({
      operation: async () => {
        const result = await client.models.OptimizationRecommendation.list({
          filter: {
            sessionId: { eq: sessionId },
          },
        });
        return result.data || [];
      },
      operationName: 'ListOptimizationRecommendations',
      component: COMPONENT_NAME,
      context: { sessionId },
    });

    console.log(`Found ${recommendationsResult.length} recommendations`);

    // ========================================================================
    // Step 3: Sort by priority (CRITICAL, HIGH, MEDIUM, LOW) and timestamp
    // ========================================================================
    const sortedRecommendations = recommendationsResult.sort((a, b) => {
      // First sort by priority (descending - higher priority first)
      const priorityA = PRIORITY_ORDER[a.priority] || 0;
      const priorityB = PRIORITY_ORDER[b.priority] || 0;
      
      if (priorityA !== priorityB) {
        return priorityB - priorityA; // Higher priority first
      }
      
      // If same priority, sort by timestamp (descending - newest first)
      const timestampA = new Date(a.timestamp).getTime();
      const timestampB = new Date(b.timestamp).getTime();
      return timestampB - timestampA;
    });

    console.log('Recommendations sorted by priority and timestamp');

    // ========================================================================
    // Publish metrics
    // ========================================================================
    const executionTime = Date.now() - startTime;
    await publishOptimizationIterationTime(executionTime, dimensions);

    // ========================================================================
    // Step 4: Return recommendations with all details
    // ========================================================================
    return sortedRecommendations;

  } catch (error) {
    const classifiedError = classifyError(error, { sessionId });
    logError(classifiedError, COMPONENT_NAME);

    // Publish error metric
    const errorCategory = classifiedError.category === ErrorCategory.TRANSIENT ? MetricsErrorCategory.TRANSIENT :
                         classifiedError.category === ErrorCategory.PERMANENT ? MetricsErrorCategory.PERMANENT :
                         classifiedError.category === ErrorCategory.SYSTEM ? MetricsErrorCategory.SYSTEM :
                         MetricsErrorCategory.PARTIAL_FAILURE;
    
    await publishErrorRate(errorCategory, classifiedError.code, dimensions);

    // Return empty array on error (query should not fail)
    console.error('Failed to get recommendations, returning empty array', classifiedError.message);
    return [];
  }
};
