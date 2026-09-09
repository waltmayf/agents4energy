import { SchemaType, type ToolDefinition } from '@aws-sdk/client-bedrock-agentcore-control';

// MCP tool schema for the s3-tools gateway target (issue #240) — moved
// verbatim from web/amplify/constructs/s3ToolsGatewayTarget/handler.ts as
// part of #536. The Lambda implementing these tools stays in
// web/amplify/functions/s3-tools/handler.ts (still shared with other web/
// consumers via web/lib/s3-fs-*) — only the CDK wiring + gateway-target
// registration moved here.
const PATH_PROPERTY = {
  type: SchemaType.STRING,
  description:
    'Filesystem path, resolved under the shared "files/" root. Absolute (leading "/") and relative paths both resolve from that same root, e.g. "/docs/production/gas_lift.md" or "reports/q3.md".',
};

export const s3ToolDefinitions: ToolDefinition[] = [
  {
    name: 'ApplyDiff',
    description:
      'Create or modify a file using one or more SEARCH/REPLACE blocks (Aider/Roo-Code apply_diff style). '
      + 'An empty SEARCH block against a non-existent path creates the file with the REPLACE body as its full content.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        path: PATH_PROPERTY,
        diff: {
          type: SchemaType.STRING,
          description:
            'One or more SEARCH/REPLACE blocks: "<<<<<<< SEARCH" then the exact existing content, then "=======", '
            + 'then the replacement content, then ">>>>>>> REPLACE". An optional ":start_line:<N>" hint line may '
            + 'follow the SEARCH marker.',
        },
      },
      required: ['path', 'diff'],
    },
  },
  {
    name: 'ListFiles',
    description: 'List files and sub-"directories" under a path (defaults to the filesystem root).',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        path: { ...PATH_PROPERTY, description: `${PATH_PROPERTY.description} Omit to list the filesystem root.` },
        recursive: {
          type: SchemaType.BOOLEAN,
          description: 'List all nested files recursively instead of only the immediate contents. Defaults to false.',
        },
      },
    },
  },
  {
    name: 'ReadFile',
    description: 'Read a file\'s contents as text.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: { path: PATH_PROPERTY },
      required: ['path'],
    },
  },
  {
    name: 'DeleteFile',
    description: 'Delete a file.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: { path: PATH_PROPERTY },
      required: ['path'],
    },
  },
  {
    name: 'UploadFile',
    description:
      'Upload a file to a destination path under the shared "files/" root. Provide exactly one of '
      + '"sourcePath" (copy an existing files/ path, e.g. to move generated output into place) or "content" '
      + '(write inline text or base64-encoded bytes).',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        destPath: {
          ...PATH_PROPERTY,
          description: `Destination ${PATH_PROPERTY.description}`,
        },
        sourcePath: {
          ...PATH_PROPERTY,
          description: `An existing source ${PATH_PROPERTY.description} to copy from. Mutually exclusive with "content".`,
        },
        content: {
          type: SchemaType.STRING,
          description: 'Inline file content to write to destPath. Mutually exclusive with "sourcePath".',
        },
        encoding: {
          type: SchemaType.STRING,
          description: 'Encoding of "content": "utf-8" (default) for text, or "base64" for binary data.',
        },
      },
      required: ['destPath'],
    },
  },
];
