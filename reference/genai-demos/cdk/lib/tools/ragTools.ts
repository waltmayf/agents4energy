import { BedrockAgentRuntimeClient, RetrieveCommand, RetrieveAndGenerateCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { z } from 'zod';

const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;

if (!knowledgeBaseId) {
  console.warn('⚠ KNOWLEDGE_BASE_ID not set - RAG tools will not function');
}

/**
 * Tool to retrieve relevant documents from the Knowledge Base
 */
export const retrieveDocumentsTool = {
  name: 'retrieve-documents',
  config: {
    description: 'Search the knowledge base for relevant documents. Returns sources with relevance scores.',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      maxResults: z.number().optional().default(5).describe('Max results (default: 5)'),
    }),
  },
  handler: async (params: { query: string; maxResults?: number }) => {
    console.log('Retrieving documents from Knowledge Base:', params);

    if (!knowledgeBaseId) {
      return {
        content: [{
          text: JSON.stringify({
            error: 'Knowledge Base not configured',
            message: 'KNOWLEDGE_BASE_ID environment variable is not set'
          })
        }]
      };
    }

    try {
      const client = new BedrockAgentRuntimeClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });

      const command = new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: {
          text: params.query,
        },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: params.maxResults || 5,
          },
        },
      });

      const response = await client.send(command);

      const results = response.retrievalResults?.map((result) => ({
        content: result.content?.text,
        score: result.score,
        location: result.location,
        metadata: result.metadata,
        // Note: Multimodal content (images, audio, video) metadata is included in the metadata field
        // The frontend will need to extract supplemental URIs from metadata fields like:
        // - x-amz-bedrock-kb-source-file-modality (IMAGE, AUDIO, VIDEO, TEXT)
        // - x-amz-bedrock-kb-source-file-mime-type
        // And generate presigned URLs for S3 access
      })) || [];

      console.log(`✓ Retrieved ${results.length} documents`);

      return {
        content: [{
          text: JSON.stringify({
            query: params.query,
            results,
            count: results.length,
          }, null, 2)
        }]
      };
    } catch (error: any) {
      console.error('✗ Failed to retrieve documents:', error);
      return {
        content: [{
          text: JSON.stringify({
            error: 'Failed to retrieve documents',
            message: error.message,
            query: params.query,
          })
        }]
      };
    }
  },
};

/**
 * Tool to retrieve documents and generate a response using RAG
 */
export const retrieveAndGenerateTool = {
  name: 'retrieve-and-generate',
  config: {
    description: 'RAG: retrieve documents and generate a source-backed answer.',
    inputSchema: z.object({
      query: z.string().describe('Question to answer using retrieved documents'),
      modelArn: z.string().optional().describe('Bedrock model ARN (default: Claude 3 Sonnet)'),
    }),
  },
  handler: async (params: { query: string; modelArn?: string }) => {
    console.log('Retrieve and generate with RAG:', params);

    if (!knowledgeBaseId) {
      return {
        content: [{
          text: JSON.stringify({
            error: 'Knowledge Base not configured',
            message: 'KNOWLEDGE_BASE_ID environment variable is not set'
          })
        }]
      };
    }

    try {
      const client = new BedrockAgentRuntimeClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });

      const modelArn = params.modelArn || 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0';

      const command = new RetrieveAndGenerateCommand({
        input: {
          text: params.query,
        },
        retrieveAndGenerateConfiguration: {
          type: 'KNOWLEDGE_BASE',
          knowledgeBaseConfiguration: {
            knowledgeBaseId,
            modelArn,
            retrievalConfiguration: {
              vectorSearchConfiguration: {
                numberOfResults: 5,
              },
            },
          },
        },
      });

      const response = await client.send(command);

      const output = response.output?.text || '';
      const citations = response.citations?.map((citation) => ({
        generatedResponsePart: citation.generatedResponsePart?.textResponsePart?.text,
        retrievedReferences: citation.retrievedReferences?.map((ref) => ({
          content: ref.content?.text,
          location: ref.location,
          metadata: ref.metadata,
        })),
      })) || [];

      console.log(`✓ Generated response with ${citations.length} citations`);

      return {
        content: [{
          text: JSON.stringify({
            query: params.query,
            response: output,
            citations,
            sessionId: response.sessionId,
          }, null, 2)
        }]
      };
    } catch (error: any) {
      console.error('✗ Failed to retrieve and generate:', error);
      return {
        content: [{
          text: JSON.stringify({
            error: 'Failed to retrieve and generate',
            message: error.message,
            query: params.query,
          })
        }]
      };
    }
  },
};

export const allRagTools = [
  retrieveDocumentsTool,
  retrieveAndGenerateTool,
];
