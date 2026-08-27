//This file will have an MCP tool which will allow the agent to execute any graphql operation
import { z } from "zod";
import { getConfiguredAmplifyClient } from "./amplifyUtils";

export const executeGraphqlTool = {
  name: "execute-graphql",
  config: {
    title: "Execute GraphQL",
    description: "Execute any GraphQL query or mutation against the AppSync API.",
    inputSchema: z.object({
      query: z.string().describe("GraphQL query or mutation"),
      variables: z.record(z.string(), z.any()).optional().describe("Variables for the operation")
    })
  },
  handler: async ({ query, variables }: { query: string; variables?: Record<string, any> | undefined }) => {
    try {
      // await setAmplifyEnvVars()
      const amplifyClient = getConfiguredAmplifyClient();
      
      const result = await amplifyClient.graphql({
        query: query as any,
        variables: variables || {}
      });

      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      // Get error details
      let errorMessage: string;
      let errorDetails: any = undefined;
      
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'object' && error !== null) {
        // For object errors (like GraphQL errors), stringify the whole thing
        errorMessage = JSON.stringify(error);
        errorDetails = error;
      } else {
        errorMessage = String(error);
      }

      return {
        content: [{ 
          type: "text" as const, 
          text: JSON.stringify({ 
            error: "Failed to execute GraphQL query",
            message: errorMessage,
            ...(errorDetails && { details: errorDetails })
          }, null, 2)
        }],
        isError: true
      };
    }
  }
};
