/**
 * executeAthenaQuery handler
 * Executes Athena SQL queries and returns results
 */

import type { Schema } from '../../data/resource';
import { StartQueryExecutionCommand } from '@aws-sdk/client-athena';
import { athena, getQueryResults } from './utils/athenaClient';

export const handler: Schema['executeAthenaQuery']['functionHandler'] = async (event) => {
  console.log('executeAthenaQuery event:', JSON.stringify(event, null, 2));
  
  const { queryString, database, catalog, queryExecutionId, nextToken } = event.arguments;

  try {
    // If queryExecutionId is provided, check status and get results
    if (queryExecutionId) {
      return await getQueryResults(queryExecutionId, nextToken ?? undefined);
    }

    // Otherwise, start a new query execution
    const params = {
      QueryString: queryString ?? undefined,
      QueryExecutionContext: {
        ...(database && { Database: database }),
        ...(catalog && { Catalog: catalog }),
      },
      WorkGroup: process.env.ATHENA_WORKGROUP,
    };

    console.log('Starting query execution:', params);
    const startCommand = new StartQueryExecutionCommand(params);
    const startResponse = await athena.send(startCommand);
    
    if (!startResponse.QueryExecutionId) {
      throw new Error('Failed to start query execution');
    }

    console.log('Query started with ID:', startResponse.QueryExecutionId);

    // Wait a moment and check initial status
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return await getQueryResults(startResponse.QueryExecutionId);
    
  } catch (error) {
    console.error('Error executing Athena query:', error);
    
    // Extract detailed error information
    let errorMessage = 'Unknown error occurred';
    let errorDetails: any = {};
    
    if (error instanceof Error) {
      errorMessage = error.message;
      console.error('Error stack:', error.stack);
      
      if ('name' in error) {
        errorDetails.errorType = error.name;
      }
      if ('$metadata' in error) {
        errorDetails.metadata = (error as any).$metadata;
      }
    } else {
      errorMessage = String(error);
    }
    
    const detailedError = errorDetails.errorType 
      ? `${errorDetails.errorType}: ${errorMessage}`
      : errorMessage;
    
    console.error('Detailed error:', detailedError, errorDetails);
    
    return {
      queryExecutionId: queryExecutionId || 'none',
      status: 'FAILED',
      error: detailedError,
    };
  }
};