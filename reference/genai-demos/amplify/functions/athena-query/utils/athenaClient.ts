/**
 * Shared Athena client utilities
 */

import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';

export const athena = new AthenaClient({ region: process.env.AWS_REGION });

export interface AthenaQueryResult {
  queryExecutionId: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  data?: any[];
  columns?: string[];
  error?: string;
  rowCount?: number;
  nextToken?: string;
}

export async function getQueryResults(queryExecutionId: string, nextToken?: string): Promise<AthenaQueryResult> {
  try {
    // Check query execution status
    const statusCommand = new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId });
    const statusResponse = await athena.send(statusCommand);
    
    const status = statusResponse.QueryExecution?.Status?.State;
    
    if (!status) {
      throw new Error('Could not determine query status');
    }

    console.log('Query status:', status);

    // If query is still running, return status without results
    if (status === 'QUEUED' || status === 'RUNNING') {
      return {
        queryExecutionId,
        status,
      };
    }

    // If query failed, return error
    if (status === 'FAILED' || status === 'CANCELLED') {
      return {
        queryExecutionId,
        status,
        error: statusResponse.QueryExecution?.Status?.StateChangeReason || 'Query failed',
      };
    }

    // Query succeeded, get results with pagination support
    const resultsCommand = new GetQueryResultsCommand({ 
      QueryExecutionId: queryExecutionId,
      MaxResults: 1000, // Return 1000 rows per page
      NextToken: nextToken, // Use provided token for pagination
    });
    const resultsResponse = await athena.send(resultsCommand);

    if (!resultsResponse.ResultSet) {
      return {
        queryExecutionId,
        status: 'SUCCEEDED',
        data: [],
        columns: [],
        rowCount: 0,
      };
    }

    // Extract column names from ResultSetMetadata (more reliable than parsing first row)
    const columns = resultsResponse.ResultSet.ResultSetMetadata?.ColumnInfo?.map(
      (col: any) => col.Name || col.Label || 'unknown_column'
    ) || [];
    
    // For paginated results, we still get all rows as data (no header row in pagination)
    // For first page with headers in data, Athena includes the header row which we need to skip
    let dataRows;
    
    if (nextToken) {
      // Pagination: all rows are data
      dataRows = resultsResponse.ResultSet.Rows || [];
    } else {
      // First page: first row might be headers (check if it matches column names)
      const allRows = resultsResponse.ResultSet.Rows || [];
      const firstRow = allRows[0];
      
      // Check if first row is a header row by comparing to column metadata
      const firstRowValues = firstRow?.Data?.map((cell: any) => cell.VarCharValue || '') || [];
      const isHeaderRow = firstRowValues.length > 0 && 
        firstRowValues.every((val: string, idx: number) => val === columns[idx]);
      
      // Skip first row only if it's a header row
      dataRows = isHeaderRow ? allRows.slice(1) : allRows;
    }
    
    // Extract data rows
    const data = dataRows.map((row: any) => {
      const rowData: Record<string, string> = {};
      row.Data?.forEach((cell: any, index: number) => {
        const columnName = columns[index] || `column_${index}`;
        rowData[columnName] = cell.VarCharValue || '';
      });
      return rowData;
    });

    const result: AthenaQueryResult = {
      queryExecutionId,
      status: 'SUCCEEDED',
      data,
      columns: nextToken ? undefined : columns, // Only include columns on first page
      rowCount: data.length,
    };

    // Include nextToken if more results are available
    if (resultsResponse.NextToken) {
      result.nextToken = resultsResponse.NextToken;
    }

    return result;
  } catch (error) {
    console.error('Error getting query results:', error);
    return {
      queryExecutionId,
      status: 'FAILED',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
