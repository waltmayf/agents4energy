import { z } from "zod";
import { generateObject } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import * as path from "path";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getConfiguredAmplifyClient } from './amplifyUtils';
import { getChatSessionId, getChatSessionPrefix } from "./toolUtils";

// GraphQL mutation for publishing progress updates to the client
const publishResponseStreamChunk = /* GraphQL */ `
  mutation PublishResponseStreamChunk($chatSessionId: String!, $chunkText: String!, $index: Int!) {
    publishResponseStreamChunk(chatSessionId: $chatSessionId, chunkText: $chunkText, index: $index) {
      chatSessionId
      chunkText
      index
    }
  }
`;

// Schema for listing files
const listFilesSchema = z.object({
    directory: z.string().optional().describe("Optional subdirectory to list files from. Use 'global' to access shared files across all sessions."),
});

// Schema for reading a file
const readFileSchema = z.object({
    filename: z.string().describe("The path to the file. This can include subdirectories"),
    startAtByte: z.number().optional().default(0).describe("The byte to start reading from. Defaults to 0."),
});

// Schema for searching files
const searchFilesSchema = z.object({
    filePattern: z.string().describe("Regex pattern to match files. For example: '.*\\.txt' for all text files, or 'data/.*' for all files in the data directory."),
    maxFiles: z.number().optional().default(100).describe("Maximum number of files to return. Defaults to 100."),
    includeGlobal: z.boolean().optional().default(true).describe("Whether to include global files in the search. Defaults to true."),
});

// Schema for writing a file
const writeFileSchema = z.object({
    filename: z.string().describe("The path to the file. This can include subdirectories"),
    content: z.string().describe("The content to write to the file"),
});

// Schema for applying a unified diff patch
const applyDiffSchema = z.object({
    filename: z.string().describe("The path to the file to patch. This can include subdirectories."),
    diff: z.string().describe("A unified diff string to apply to the file. Use standard unified diff format with --- / +++ headers and @@ hunk markers."),
});

// Schema for updating a file
const updateFileSchema = z.object({
    filename: z.string().describe("The path to the file. This can include subdirectories"),
    operation: z.enum(["append", "prepend", "replace"]).describe("The type of update operation: append (add to end), prepend (add to beginning), or replace (find and replace content)"),
    content: z.string().describe("The content to add or use as replacement"),
    searchString: z.string().optional().describe("When using replace operation, the string to search for and replace. Required for replace operation."),
    createIfNotExists: z.boolean().optional().default(true).describe("Whether to create the file if it doesn't exist. Defaults to true."),
    isRegex: z.boolean().optional().default(false).describe("Whether the searchString should be treated as a regular expression. Defaults to false."),
    regexFlags: z.string().optional().default("g").describe("Flags for the regular expression (e.g., 'g' for global, 'm' for multiline, 'i' for case-insensitive). Default is 'g'. Only used when isRegex is true."),
    multiLine: z.boolean().optional().default(false).describe("Whether to enable multiline matching. This is a shorthand to set regexFlags to 'gm'. Only used when isRegex is true."),
});

// Schema for text to table conversion
const textToTableSchema = z.object({
    filePattern: z.string().describe("Regex pattern to select files for inclusion in the table. For example: '.*\\.txt' for all text files, or 'data/.*' for all files in the data directory."),
    tableTitle: z.string().describe("The title of the table to be created."),
    tableColumns: z.array(
        z.object({
            columnName: z.string().describe("The name of the column to include in the table."),
            columnDescription: z.string().describe("A clear description of what information should be extracted for this column."),
            columnDataDefinition: z.object({
                type: z.union([z.string(), z.array(z.string())]).describe("The data type of the column. Can be 'string', 'number', 'boolean', or an array of types."),
                format: z.string().optional().describe("Optional format for the data, e.g., 'date', 'email', etc."),
                pattern: z.string().optional().describe("Optional regex pattern that the value must match."),
                minimum: z.number().optional().describe("Optional minimum value for number types."),
                maximum: z.number().optional().describe("Optional maximum value for number types."),
                enum: z.array(z.string()).optional().describe("Optional array of allowed values for the column.")
            }).optional().describe("Schema definition for the column data.")
        })
    ).describe("Array of column definitions for the table."),
    includeFilePath: z.boolean().optional().default(true).describe("Whether to include the file path as a column in the table. Defaults to true."),
    maxFiles: z.number().optional().default(50).describe("Maximum number of files to process. Defaults to 50."),
    dataToInclude: z.string().optional().describe("Description of what data to prioritize inclusion of in the table."),
    dataToExclude: z.string().optional().describe("Description of what data to exclude or de-prioritize from the table."),
});

interface FieldDefinition {
    type: string | Array<string>;
    description: string;
    format?: string;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    default?: unknown;
    items?: unknown;
}

interface JsonSchema {
    title: string | Array<string>;
    description: string;
    type: string;
    properties: Record<string, FieldDefinition>;
    required: string[];
}

/**
 * Uses ai-sdk generateObject to extract structured data from text using a Bedrock model.
 */
export const getStructuredOutputResponse = async (props: { modelId: string, prompt: string, outputStructure: JsonSchema }) => {
    const region = process.env.AWS_REGION || 'us-east-1';
    const bedrock = createAmazonBedrock({ region });
    const model = bedrock(props.modelId);

    // Build a zod schema dynamically from the JsonSchema properties
    const zodShape: Record<string, z.ZodTypeAny> = {};
    for (const [key, field] of Object.entries(props.outputStructure.properties)) {
        const types = Array.isArray(field.type) ? field.type : [field.type];
        const isNullable = types.includes('null');
        const primaryType = types.find(t => t !== 'null') || 'string';

        let zodField: z.ZodTypeAny;
        if (primaryType === 'number') {
            let numField = z.number();
            if (field.minimum !== undefined) numField = numField.min(field.minimum);
            if (field.maximum !== undefined) numField = numField.max(field.maximum);
            zodField = numField;
        } else if (primaryType === 'boolean') {
            zodField = z.boolean();
        } else {
            zodField = z.string();
        }

        if (isNullable) {
            zodField = zodField.nullable();
        }

        zodField = zodField.describe(field.description);
        zodShape[key] = zodField;
    }

    const zodSchema = z.object(zodShape);

    const result = await generateObject({
        model,
        schema: zodSchema,
        prompt: props.prompt,
        temperature: 0,
    });

    // Replace '<UNKNOWN>' values with null
    const parsed = result.object as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
        for (const key of Object.keys(parsed)) {
            if (parsed[key] === '<UNKNOWN>') {
                parsed[key] = null;
            }
        }
    }

    return parsed;
};


// Helper functions for S3 operations
function getS3Client() {
    return new S3Client();
}

function getBucketName() {
    const bucketName = process.env.STORAGE_BUCKET_NAME;
    if (!bucketName) {
        throw new Error("STORAGE_BUCKET_NAME is not set");
    }
    return bucketName;
}

// Global prefix for shared files
const GLOBAL_PREFIX = 'global/';

// Get the correct S3 prefix based on path
function getS3KeyPrefix(filepath: string) {
    if (filepath.startsWith('global/')) {
        return '';
    }
    return getChatSessionPrefix();
}

async function listS3Objects(prefix: string) {
    const s3Client = getS3Client();
    const bucketName = getBucketName();

    const listParams = {
        Bucket: bucketName,
        Prefix: prefix,
        Delimiter: '/'
    };

    try {
        const command = new ListObjectsV2Command(listParams);
        const response = await s3Client.send(command);

        const directories = (response.CommonPrefixes || [])
            .map(prefixObj => {
                const name = prefixObj.Prefix?.replace(prefix, '').replace('/', '');
                return name ? { name, type: 'directory' as const } : null;
            })
            .filter((item): item is { name: string; type: 'directory' } => item !== null);

        const files = (response.Contents || [])
            .filter(item => item.Key !== prefix)
            .map(item => {
                const key = item.Key as string;
                const name = key.substring(prefix.length);
                return name && !name.endsWith('/') && !name.endsWith('.s3meta')
                    ? { name, type: 'file' as const }
                    : null;
            })
            .filter((item): item is { name: string; type: 'file' } => item !== null);

        return [...directories, ...files];
    } catch (error) {
        console.error("Error listing S3 objects:", error);
        throw error;
    }
}

interface S3ReadResult {
    content: string;
    wasTruncated: boolean;
    totalBytes: number;
    bytesRead: number;
    truncationMessage?: string | undefined;
}

export async function readS3Object(props: { key: string, maxBytes: number, startAtByte: number }): Promise<S3ReadResult> {
    const { key, maxBytes = 8192, startAtByte = 0 } = props;
    const s3Client = getS3Client();
    const bucketName = getBucketName();

    const getParams = {
        Bucket: bucketName,
        Key: key,
        Range: maxBytes > 0 ? `bytes=${startAtByte}-${startAtByte + maxBytes - 1}` : undefined
    };

    try {
        const command = new GetObjectCommand(getParams);
        const response = await s3Client.send(command);

        if (response.Body) {
            const chunks: Buffer[] = [];
            for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
                chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
            }
            const content = Buffer.concat(chunks).toString('utf8');

            const contentLength = parseInt(response.ContentRange?.split('/')[1] || '0', 10);
            const wasTruncated = maxBytes > 0 && (contentLength - startAtByte) > maxBytes;
            const endByte = startAtByte + content.length;

            return {
                content,
                wasTruncated,
                totalBytes: contentLength,
                bytesRead: content.length,
                truncationMessage: wasTruncated ?
                    `\n[...File truncated. Showing bytes ${startAtByte} to ${endByte} of ${contentLength} total bytes...]\n Call this tool again with startAtByte=${endByte} to read more of the file.` :
                    undefined
            };
        } else {
            throw new Error("No content found");
        }
    } catch (error: unknown) {
        const s3Error = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (s3Error.name === 'NoSuchKey') {
            throw error;
        }
        if (s3Error.$metadata?.httpStatusCode === 416) {
            const retryCommand = new GetObjectCommand({
                Bucket: bucketName,
                Key: key
            });
            const response = await s3Client.send(retryCommand);
            if (response.Body) {
                const chunks: Buffer[] = [];
                for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
                    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
                }
                const content = Buffer.concat(chunks).toString('utf8');
                return {
                    content,
                    wasTruncated: false,
                    totalBytes: content.length,
                    bytesRead: content.length,
                    truncationMessage: undefined
                };
            }
        }
        console.error(`Error reading S3 object ${key}:`, error);
        throw error;
    }
    throw new Error("Failed to read file content");
}

async function writeS3Object(key: string, content: string) {
    const upload = new Upload({
        client: getS3Client(),
        params: {
            Bucket: getBucketName(),
            Key: key,
            Body: content
        }
    });

    const response = await upload.done();
    console.log(`Response from uploading file to bucket ${getBucketName()} and key ${key}: `, response);
}

function getContentType(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    const contentTypeMap: Record<string, string> = {
        '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
        '.js': 'application/javascript', '.json': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
        '.md': 'text/markdown', '.csv': 'text/csv', '.xml': 'application/xml',
        '.zip': 'application/zip', '.py': 'text/x-python',
        '.ts': 'text/typescript', '.tsx': 'text/typescript'
    };
    return contentTypeMap[extension] || 'application/octet-stream';
}


// Helper function to process document links
export function processDocumentLinks(content: string, chatSessionId: string): string {
    const originBasePath = process.env.ORIGIN_BASE_PATH || "";

    const getFullUrl = (filePath: string) => {
        if (filePath.startsWith(`${originBasePath}/file/`) || filePath.startsWith('http://') || filePath.startsWith('https://')) {
            return filePath;
        }
        while (filePath.startsWith('../')) {
            filePath = filePath.slice(3);
        }
        if (filePath.startsWith('global/')) {
            return `${originBasePath}/file/${filePath}`;
        }
        if (filePath.startsWith(`${originBasePath}/preview`)) {
            return filePath;
        }
        return `${originBasePath}/file/chatSessionArtifacts/sessionId=${chatSessionId}/${filePath}`;
    };

    const linkRegex = /href="([^"]+)"/g;
    const iframeSrcRegex = /<iframe[^>]*\ssrc="([^"]+)"[^>]*>/g;

    let processedContent = content.replace(linkRegex, (_match, filePath: string) => {
        const fullPath = getFullUrl(filePath);
        return `href="${fullPath}"`;
    });

    processedContent = processedContent.replace(iframeSrcRegex, (match, filePath: string) => {
        const fullPath = getFullUrl(filePath);
        return match.replace(`src="${filePath}"`, `src="${fullPath}"`);
    });

    return processedContent;
}

// Tool: List files
const listFilesTool = {
    name: 'list-files',
    config: {
        title: 'List Files',
        description: "Lists files and directories from S3 storage. The response clearly distinguishes between directories and files. Use 'global' or 'global/path' to access shared files across all sessions, or a regular path for session-specific files.",
        inputSchema: listFilesSchema,
    },
    handler: async (params: { directory?: string }) => {
        try {
            const directory = params.directory || "";

            if (directory.startsWith('global') || directory === 'global') {
                const globalDir = directory === 'global' ? 'global/' : directory;
                let fullPrefix = path.posix.join('', globalDir);
                if (!fullPrefix.endsWith('/')) fullPrefix += '/';

                const items = await listS3Objects(fullPrefix);
                const directories = items.filter(item => item.type === 'directory');
                const files = items.filter(item => item.type === 'file');

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                        path: directory, directories: directories.map(d => d.name),
                        files: files.map(f => f.name), items
                    }) }]
                };
            }

            const sessionPrefix = getChatSessionPrefix();
            let fullPrefix = path.posix.join(sessionPrefix, directory);
            if (!fullPrefix.endsWith('/')) fullPrefix += '/';

            const items = await listS3Objects(fullPrefix);
            const directories = items.filter(item => item.type === 'directory');
            const files = items.filter(item => item.type === 'file');

            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    path: directory, directories: directories.map(d => d.name),
                    files: files.map(f => f.name), items
                }) }]
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Error listing files: ${message}` }) }],
                isError: true
            };
        }
    },
};

// Tool: Read file
const readFileTool = {
    name: 'read-file',
    config: {
        title: 'Read File',
        description: "Reads the content of a file from S3 storage. Use 'global/filename' path to access shared files across all sessions. By default, only reads the first 8KB of data to prevent loading very large files.",
        inputSchema: readFileSchema,
    },
    handler: async (params: { filename: string; startAtByte?: number }) => {
        const maxBytes = 8192;
        try {
            const targetPath = path.normalize(params.filename);
            if (targetPath.startsWith("..")) {
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: "Invalid file path. Cannot access files outside project root directory." }) }],
                    isError: true
                };
            }

            const prefix = getS3KeyPrefix(targetPath);
            const s3Key = path.posix.join(prefix, targetPath);

            try {
                const result = await readS3Object({ key: s3Key, maxBytes, startAtByte: params.startAtByte || 0 });
                let displayContent = result.content;
                if (result.wasTruncated) {
                    displayContent = displayContent + (result.truncationMessage || '');
                }

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                        content: displayContent, wasTruncated: result.wasTruncated,
                        totalBytes: result.totalBytes, bytesRead: result.bytesRead
                    }) }]
                };
            } catch (error: unknown) {
                const s3Error = error as { name?: string };
                if (s3Error.name === 'NoSuchKey') {
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify({ error: `File not found: ${params.filename}` }) }],
                        isError: true
                    };
                }
                throw error;
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: `Error reading file: ${message}` }) }],
                isError: true
            };
        }
    },
};


// Tool: Update file
const updateFileTool = {
    name: 'update-file',
    config: {
        title: 'Update File',
        description: "Updates a file in session storage. Global files (global/filename) are read-only and cannot be updated.",
        inputSchema: updateFileSchema,
    },
    handler: async (params: {
        filename: string; operation: "append" | "prepend" | "replace"; content: string;
        searchString?: string; createIfNotExists?: boolean; isRegex?: boolean;
        regexFlags?: string; multiLine?: boolean;
    }) => {
        try {
            const {
                filename, operation, content, searchString,
                createIfNotExists = true, isRegex = false,
                regexFlags = "g", multiLine = false
            } = params;

            const targetPath = path.normalize(filename);
            if (targetPath.startsWith("..")) {
                return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "Invalid file path. Cannot update files outside project root directory." }) }], isError: true };
            }
            if (targetPath.startsWith("global/") && !targetPath.startsWith("global/notes/")) {
                return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "Cannot update files in the global directory. Global files are read-only. Exception: global/notes/ is writable." }) }], isError: true };
            }

            const prefix = getS3KeyPrefix(targetPath);
            const s3Key = path.posix.join(prefix, targetPath);

            let existingContent = "";
            let fileExists = true;

            try {
                const result = await readS3Object({ key: s3Key, maxBytes: 0, startAtByte: 0 });
                existingContent = result.content;
            } catch (error: unknown) {
                const s3Error = error as { name?: string };
                if (s3Error.name === 'NoSuchKey') {
                    fileExists = false;
                    if (!createIfNotExists) {
                        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `File does not exist: ${filename}` }) }], isError: true };
                    }
                } else {
                    throw error;
                }
            }

            let newContent: string;

            switch (operation) {
                case "append":
                    newContent = existingContent + content;
                    break;
                case "prepend":
                    newContent = content + existingContent;
                    break;
                case "replace":
                    if (!existingContent || existingContent.length === 0 || !searchString) {
                        newContent = content;
                        break;
                    }
                    if (isRegex) {
                        const flags = multiLine ? "gm" : regexFlags;
                        try {
                            const regex = new RegExp(searchString ?? '', flags);
                            newContent = existingContent.replace(regex, content);
                        } catch (regexError: unknown) {
                            const message = regexError instanceof Error ? regexError.message : String(regexError);
                            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid regular expression: ${message}` }) }], isError: true };
                        }
                    } else {
                        if (multiLine) {
                            const lines = existingContent.split('\n');
                            const searchLines = (searchString ?? '').split('\n');
                            for (let i = 0; i <= lines.length - searchLines.length; i++) {
                                let matches = true;
                                for (let j = 0; j < searchLines.length; j++) {
                                    if (lines[i + j] !== searchLines[j]) { matches = false; break; }
                                }
                                if (matches) {
                                    lines.splice(i, searchLines.length);
                                    const contentLines = content.split('\n');
                                    for (let j = contentLines.length - 1; j >= 0; j--) {
                                        const line = contentLines[j];
                                        if (line !== undefined) lines.splice(i, 0, line);
                                    }
                                    i += contentLines.length - 1;
                                }
                            }
                            newContent = lines.join('\n');
                        } else {
                            newContent = existingContent.split(searchString ?? '').join(content);
                        }
                    }
                    break;
                default:
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "Invalid operation. Must be 'append', 'prepend', or 'replace'" }) }], isError: true };
            }

            const finalContent = processDocumentLinks(newContent, getChatSessionId() || '');
            await writeS3Object(s3Key, finalContent);

            const verificationResult = await readS3Object({ key: s3Key, maxBytes: 0, startAtByte: 0 });
            const lines = verificationResult.content.split('\n');
            const contextLines = 3;
            let contentStartLine = 0;
            if (operation === 'append') {
                contentStartLine = Math.max(0, lines.length - contextLines);
            } else if (operation === 'prepend') {
                contentStartLine = 0;
            } else if (operation === 'replace' && searchString) {
                contentStartLine = lines.findIndex(line => line.includes(content));
                if (contentStartLine === -1) contentStartLine = 0;
            }
            const startLine = Math.max(0, contentStartLine - contextLines);
            const endLine = Math.min(lines.length, contentStartLine + contextLines + 1);
            const contentWithContext = lines.slice(startLine, endLine).join('\n');

            const operationMessage = { "append": "appended to", "prepend": "prepended to", "replace": "updated in" }[operation];

            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    success: true, message: `Content successfully ${operationMessage} file ${filename}`,
                    operation, fileExistedBefore: fileExists,
                    updatedContent: { content: contentWithContext, startLine: startLine + 1, endLine, wasTruncated: verificationResult.wasTruncated }
                }) }]
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Error updating file: ${message}` }) }], isError: true };
        }
    },
};


// Tool: Write file
export const writeFileTool = {
    name: 'write-file',
    config: {
        title: 'Write File',
        description: `Writes content to a new file or overwrites an existing file in session storage.
For HTML files:
1. Automatically processes document links (relative paths become full asset paths).
2. For including content from other HTML files, use iframes with relative paths.
Global files (global/filename) are read-only and cannot be written to.`,
        inputSchema: writeFileSchema,
    },
    handler: async (params: { filename: string; content: string }) => {
        const { filename, content } = params;
        console.log('writeFile tool called with filename:', filename);
        try {
            const targetPath = path.normalize(filename);
            if (targetPath.startsWith("..")) {
                return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "Invalid file path. Cannot write files outside project root directory." }) }], isError: true };
            }
            if (targetPath.startsWith("global/") && !targetPath.startsWith("global/notes/")) {
                return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "Cannot write files to the global directory. Global files are read-only. Exception: global/notes/ is writable." }) }], isError: true };
            }

            const prefix = getS3KeyPrefix(targetPath);
            const s3Key = path.posix.join(prefix, targetPath);

            // Create parent directory keys if needed
            const dirPath = path.dirname(targetPath);
            if (dirPath !== '.') {
                const directories = dirPath.split('/').filter(Boolean);
                let currentPath = prefix;
                for (const dir of directories) {
                    currentPath = path.posix.join(currentPath, dir, '/');
                    await writeS3Object(currentPath, '');
                }
            }

            // Process HTML embeddings if this is an HTML file
            let finalContent = content;
            if (targetPath.toLowerCase().endsWith('.html')) {
                const allowedImageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
                const allowedIframeExtensions = ['.html', '.png', '.jpg', '.jpeg', '.gif', '.svg'];

                const validateFileExtension = (src: string, allowedExts: string[], elementType: string) => {
                    const fileExtension = path.extname(src).toLowerCase();
                    if (!allowedExts.includes(fileExtension)) {
                        throw new Error(
                            `Invalid ${elementType} usage: src="${src}". ` +
                            `${elementType} can only be used with the following file types: ${allowedExts.join(', ')}`
                        );
                    }
                };

                const iframeRegex = /<iframe[^>]*\ssrc="([^"]+)"[^>]*>/g;
                let match;
                while ((match = iframeRegex.exec(content)) !== null) {
                    const src = match[1];
                    if (src) validateFileExtension(src, allowedIframeExtensions, 'iframe');
                }
                const imgRegex = /<img[^>]*\ssrc="([^"]+)"[^>]*>/g;
                while ((match = imgRegex.exec(content)) !== null) {
                    const src = match[1];
                    if (src) validateFileExtension(src, allowedImageExtensions, 'img');
                }

                finalContent = processDocumentLinks(content, getChatSessionId() || '');
            }

            await writeS3Object(s3Key, finalContent);

            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    success: true, message: `File ${filename} written successfully to S3`,
                    targetPath, s3Key, s3Bucket: getBucketName()
                }) }]
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Error writing file: ${message}` }) }], isError: true };
        }
    },
};


// Helper function to check if a file matches the given pattern
function fileMatchesPattern(filePath: string, pattern: string): boolean {
    try {
        const regex = new RegExp(pattern);
        return regex.test(filePath);
    } catch (error) {
        console.error(`Invalid regex pattern: ${pattern}`, error);
        return false;
    }
}

function normalizeColumnName(name: string): string {
    return name.replace(/\s+/g, '').toLowerCase();
}

interface TextToTableParams {
    filePattern: string;
    tableTitle: string;
    tableColumns: Array<{
        columnName: string;
        columnDescription: string;
        columnDataDefinition?: {
            type: string | string[];
            [key: string]: unknown;
        };
    }>;
    includeFilePath?: boolean;
    maxFiles?: number;
    dataToInclude?: string;
    dataToExclude?: string;
}

function getUserPrefix(): string {
    return getChatSessionPrefix();
}

let progressUpdateStartTime: Date | null = null;


async function publishProgressUpdate(
    processedCount: number, totalCount: number,
    chatSessionId: string, startTime?: Date
) {
    const amplifyClient = getConfiguredAmplifyClient();
    try {
        if (!progressUpdateStartTime) {
            progressUpdateStartTime = startTime || new Date();
        }
        const timeElapsed = (new Date().getTime() - progressUpdateStartTime.getTime()) / 1000;
        let timeRemaining = "calculating...";
        if (processedCount > 0) {
            const timePerItem = timeElapsed / processedCount;
            const remainingItems = totalCount - processedCount;
            const estimatedSecondsRemaining = timePerItem * remainingItems;
            if (estimatedSecondsRemaining < 60) {
                timeRemaining = `${Math.round(estimatedSecondsRemaining)} seconds`;
            } else if (estimatedSecondsRemaining < 3600) {
                timeRemaining = `${Math.round(estimatedSecondsRemaining / 60)} minutes`;
            } else {
                const hours = Math.floor(estimatedSecondsRemaining / 3600);
                const minutes = Math.round((estimatedSecondsRemaining % 3600) / 60);
                timeRemaining = `${hours} hour${hours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
            }
        }
        const progressPercentage = Math.round((processedCount / totalCount) * 100);
        const progressMessage = `Processing files: ${processedCount}/${totalCount} (${progressPercentage}%) - Est. time remaining: ${timeRemaining}`;
        await amplifyClient.graphql({
            query: publishResponseStreamChunk,
            variables: { chunkText: progressMessage, index: 1, chatSessionId }
        });
    } catch (error) {
        console.error('Error publishing progress update:', error);
    }
}


async function retryWithExponentialBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    initialDelayMs: number = 1000,
    maxDelayMs: number = 10000
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: unknown) {
            lastError = error;
            const message = error instanceof Error ? error.message : '';
            const isThrottlingError = message.toLowerCase().includes('too many tokens') ||
                message.toLowerCase().includes('rate limit') ||
                message.toLowerCase().includes('throttle');
            if (!isThrottlingError) throw error;
            if (attempt === maxRetries - 1) break;
            const delayMs = Math.min(initialDelayMs * Math.pow(2, attempt) * (0.5 + Math.random()), maxDelayMs);
            console.log(`Throttling detected, retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
}


// Tool: Text to Table
const textToTableTool = {
    name: 'text-to-table',
    config: {
        title: 'Text to Table',
        description: `This tool converts unstructured text files into a structured table format.
Provide a regex pattern to select files and define the columns you want in the table.
This tool is best used when you need to extract structured data from a text file, and not when you need to extract a table from a table (like when processing csv files).

File pattern examples:
- ".*\\.txt$" - all text files
- "data/.*" - all files in the data directory
- "15_9_19_A" - files containing "15_9_19_A" anywhere in the path (simplified search)

IMPORTANT: The pattern is automatically adjusted to improve matching.
If you're looking for files containing a specific string, you can just provide that string.`,
        inputSchema: textToTableSchema,
    },
    handler: async (params: TextToTableParams) => {
        try {
            progressUpdateStartTime = new Date();
            const amplifyClient = getConfiguredAmplifyClient();
            await amplifyClient.graphql({
                query: publishResponseStreamChunk,
                variables: {
                    chunkText: `Starting text to table conversion for files matching pattern: ${params.filePattern}\n`,
                    index: 0, chatSessionId: getChatSessionId() || ''
                }
            });

            console.log("textToTableTool params:", JSON.stringify(params, null, 2));
            const matchingFiles: string[] = [];

            const userFiles = await findFilesMatchingPattern(getUserPrefix(), params.filePattern);
            matchingFiles.push(...userFiles);
            const globalWellFiles = await findFilesMatchingPattern(GLOBAL_PREFIX + 'well-files/', params.filePattern);
            matchingFiles.push(...globalWellFiles);
            const globalProductionFiles = await findFilesMatchingPattern(GLOBAL_PREFIX + 'production-data/', params.filePattern);
            matchingFiles.push(...globalProductionFiles);

            console.log(`Found ${matchingFiles.length} matching files`);

            const textExtensions = ['.txt', '.md', '.json', '.jsonl', '.yaml', '.yml', '.xml'];
            const filteredFiles = matchingFiles.filter(file => {
                const lowerCaseFile = file.toLowerCase();
                return textExtensions.some(ext => lowerCaseFile.endsWith(ext.toLowerCase()));
            });

            if (filteredFiles.length === 0) {
                const searchSuggestions = [
                    "Try a simpler search pattern",
                    "Check if the files exist using the listFiles tool first",
                    "For global files, you can omit the 'global/' prefix",
                    "Try using a broader pattern (e.g., '.*' for all files)"
                ];
                const errorMessage: Record<string, unknown> = {
                    error: `No files found matching pattern: ${params.filePattern}`,
                    suggestions: searchSuggestions
                };
                try {
                    const sampleGlobalFiles = await listAvailableFiles(GLOBAL_PREFIX, 5);
                    const sampleUserFiles = await listAvailableFiles(getUserPrefix(), 5);
                    if (sampleGlobalFiles.length > 0 || sampleUserFiles.length > 0) {
                        errorMessage.availableFiles = {
                            message: "Here are some files that are available:",
                            global: sampleGlobalFiles, user: sampleUserFiles
                        };
                    }
                } catch (error) { console.error("Error getting sample files:", error); }
                return { content: [{ type: 'text' as const, text: JSON.stringify(errorMessage) }], isError: true };
            }

            const maxFiles = params.maxFiles || 20;
            if (filteredFiles.length > maxFiles) {
                console.log(`Found ${filteredFiles.length} matching files, limiting to ${maxFiles}`);
                filteredFiles.splice(maxFiles);
            }
            console.log(`Processing ${filteredFiles.length} files`);

            params.tableColumns = params.tableColumns.filter(column => column.columnName.toLowerCase() !== 'filepath');
            const columnNameMap = Object.fromEntries(
                params.tableColumns
                    .filter(column => column.columnName !== normalizeColumnName(column.columnName))
                    .map(column => [normalizeColumnName(column.columnName), column.columnName])
            );

            let enhancedTableColumns = [...params.tableColumns];
            if (params.dataToInclude || params.dataToExclude) {
                enhancedTableColumns.push({
                    columnName: 'relevanceScore',
                    columnDescription: `${params.dataToExclude ? `If the text contains information related to [${params.dataToExclude}], give a lower score.` : ''} ${params.dataToInclude ? `Give a higher score if text contains information related to [${params.dataToInclude}].` : ''} Score on a scale from 0 to 10.`,
                    columnDataDefinition: { type: 'number', minimum: 0, maximum: 10 }
                });
                enhancedTableColumns.push({
                    columnName: 'relevanceExplanation',
                    columnDescription: `Explain why this content received its relevance score.`,
                    columnDataDefinition: { type: 'string' }
                });
            }

            enhancedTableColumns.forEach(column => {
                if (column.columnName.toLowerCase().includes("date")) {
                    column.columnDataDefinition = {
                        type: ['string', 'null'], format: 'date',
                        pattern: "^(?:\\d{4})-(?:(0[1-9]|1[0-2]))-(?:(0[1-9]|[12]\\d|3[01]))$"
                    };
                }
            });

            // Build JSON schema for structured output
            const fieldDefinitions: Record<string, FieldDefinition> = {};
            for (const column of enhancedTableColumns) {
                const normalizedColumnName = normalizeColumnName(column.columnName);
                fieldDefinitions[normalizedColumnName] = {
                    ...(column.columnDataDefinition ? {
                        ...column.columnDataDefinition,
                        type: Array.isArray(column.columnDataDefinition.type)
                            ? [...new Set([...column.columnDataDefinition.type, 'null'])]
                            : [column.columnDataDefinition.type, 'null']
                    } : { type: ['string'] }),
                    description: column.columnDescription
                } as FieldDefinition;
            }

            const enumValues = enhancedTableColumns
                .filter(column => column.columnDataDefinition?.enum)
                .flatMap(column => column.columnDataDefinition?.enum) as string[];

            const jsonSchema: JsonSchema = {
                title: "extractTableData",
                description: "Extract structured data from text content",
                type: "object",
                properties: fieldDefinitions,
                required: Object.keys(fieldDefinitions).filter(key => key !== 'FilePath')
            };

            console.log('Target JSON schema for row:', JSON.stringify(jsonSchema, null, 2));

            const tableRows: Record<string, unknown>[] = [];
            const concurrencyLimit = parseInt(process.env.TEXT_TO_TABLE_CONCURRENCY || '2');
            let processedCount = 0;

            for (let i = 0; i < filteredFiles.length; i += concurrencyLimit) {
                const batch = filteredFiles.slice(i, i + concurrencyLimit);
                const batchPromises = batch.map(async (fileKey) => {
                    try {
                        const result = await readS3Object({ key: fileKey, maxBytes: 0, startAtByte: 0 });
                        const fileContent = result.content.substring(0, 10000);
                        const filePath = fileKey.startsWith(GLOBAL_PREFIX)
                            ? fileKey.replace(GLOBAL_PREFIX, 'global/')
                            : fileKey.replace(getUserPrefix(), '');

                        const enumMatches = enumValues.map(enumValue => {
                            const words = enumValue.split(/\s+/);
                            const regexPattern = words.map(word => `\\b${word}\\b`).join('|');
                            const regex = new RegExp(regexPattern, 'gi');
                            const matches: { value: string; matchedWord: string; context: string }[] = [];
                            let match;
                            while ((match = regex.exec(fileContent)) !== null) {
                                matches.push({
                                    value: enumValue, matchedWord: match[0],
                                    context: fileContent.slice(Math.max(0, match.index - 100), match.index + 100 + match[0].length)
                                });
                            }
                            return matches;
                        });

                        const enumMatchesMessage = `Enum matches found in the file: ${enumMatches.flat().map(m => m.value).join(', ')}. Showing 100 characters before and after each match.`;
                        const prompt = `Extract structured data from the following text content according to the provided schema.
<TextContent>
${fileContent}
</TextContent>
<EnumMatches>
${enumMatchesMessage}
</EnumMatches>`;

                        try {
                            const structuredData = await retryWithExponentialBackoff(
                                async () => {
                                    if (!process.env.TEXT_TO_TABLE_MODEL_ID) {
                                        throw new Error("TEXT_TO_TABLE_MODEL_ID is not set");
                                    }
                                    return await getStructuredOutputResponse({
                                        modelId: process.env.TEXT_TO_TABLE_MODEL_ID,
                                        prompt,
                                        outputStructure: jsonSchema
                                    });
                                }, 1, 5000, 10000
                            ) as Record<string, unknown>;

                            if (params.includeFilePath !== false) {
                                structuredData['FilePath'] = `/preview/${fileKey}`;
                            }
                            Object.keys(structuredData).forEach(key => {
                                if (key in columnNameMap) {
                                    const mappedKey = columnNameMap[key];
                                    if (mappedKey) {
                                        structuredData[mappedKey] = structuredData[key];
                                    }
                                    delete structuredData[key];
                                }
                            });
                            return structuredData;
                        } catch (error: unknown) {
                            console.error("Error processing with structured output:", error);
                            const errorRow: Record<string, unknown> = {
                                error: `Model structured output error: ${error instanceof Error ? error.message : String(error)}`
                            };
                            if (params.includeFilePath !== false) errorRow['FilePath'] = `/preview/${fileKey}`;
                            return errorRow;
                        }
                    } catch (error: unknown) {
                        console.error(`Error processing file ${fileKey}:`, error);
                        const errorRow: Record<string, unknown> = {};
                        if (params.includeFilePath !== false) errorRow['FilePath'] = `/preview/${fileKey}`;
                        errorRow['error'] = `Failed to process: ${error instanceof Error ? error.message : String(error)}`;
                        return errorRow;
                    }
                });
                const batchResults = await Promise.all(batchPromises);
                tableRows.push(...batchResults);
                processedCount += batch.length;
                await publishProgressUpdate(processedCount, filteredFiles.length, getChatSessionId() || '', new Date());
            }

            console.log(`Generated ${tableRows.length} table rows`);
            const firstColumn = enhancedTableColumns[0];
            const firstColumnName = firstColumn?.columnName ?? '';
            tableRows.sort((a, b) => {
                const valueA = a[firstColumnName];
                const valueB = b[firstColumnName];
                if (valueA === null || valueA === undefined) return 1;
                if (valueB === null || valueB === undefined) return -1;
                if (typeof valueA === 'number' && typeof valueB === 'number') return valueA - valueB;
                if (typeof valueA === 'string' && typeof valueB === 'string') return valueA.localeCompare(valueB);
                return String(valueA).localeCompare(String(valueB));
            });

            try {
                const columnNames = enhancedTableColumns
                    .filter(c => !['relevanceScore', 'relevanceExplanation'].includes(c.columnName))
                    .map(c => c.columnName);
                if (params.includeFilePath !== false) columnNames.push('FilePath');

                let htmlContent = `<!DOCTYPE html>
<html><head><title>${params.tableTitle}</title>
<style>
body { font-family: Arial, sans-serif; margin: 20px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
th { background-color: #f2f2f2; }
tr:nth-child(even) { background-color: #f9f9f9; }
tr:hover { background-color: #f1f1f1; }
a { color: #0066cc; text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { color: #333; }
</style></head><body><table><thead><tr>
${columnNames.map(name => `<th>${name}</th>`).join('')}
</tr></thead><tbody>`;

                tableRows.forEach(row => {
                    if (row.EventType && row.EventType === 'administrative') return;
                    htmlContent += '<tr>';
                    columnNames.forEach(colName => {
                        const cellValue = row[colName] === null || row[colName] === undefined ? '' : String(row[colName]);
                        if (colName === 'FilePath' && cellValue) {
                            htmlContent += `<td><a href="${cellValue}" target="_blank">link</a></td>`;
                        } else {
                            htmlContent += `<td>${cellValue}</td>`;
                        }
                    });
                    htmlContent += '</tr>';
                });
                htmlContent += '</tbody></table></body></html>';

                const htmlFilename = `data/${params.tableTitle}.html`;
                await writeFileTool.handler({ filename: htmlFilename, content: htmlContent });

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                        messageContentType: 'tool_table',
                        columns: enhancedTableColumns.map(c => c.columnName),
                        data: tableRows, matchedFileCount: filteredFiles.length,
                        htmlFile: { filename: htmlFilename, rowCount: tableRows.length }
                    }) }]
                };
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('Error saving CSV file:', error);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                        messageContentType: 'tool_table',
                        columns: enhancedTableColumns.map(c => c.columnName),
                        data: tableRows, matchedFileCount: filteredFiles.length,
                        csvError: `Failed to save CSV file: ${message}`
                    }) }]
                };
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Error in textToTableTool:', error);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    error: `Error: ${message}`,
                    suggestion: "Check the file pattern and try again with a simpler pattern"
                }) }], isError: true
            };
        }
    },
};


async function listAvailableFiles(prefix: string, limit: number = 10): Promise<string[]> {
    const s3Client = getS3Client();
    const bucketName = getBucketName();
    try {
        const command = new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, MaxKeys: 20 });
        const response = await s3Client.send(command);
        return (response.Contents || [])
            .filter(item => {
                const key = item.Key as string;
                return !key.endsWith('/') && !key.endsWith('.s3meta');
            })
            .map(item => (item.Key as string).replace(prefix, ''))
            .slice(0, limit);
    } catch (error) {
        console.error(`Error listing available files: ${error}`);
        return [];
    }
}


async function findFilesMatchingPattern(basePrefix: string, pattern: string): Promise<string[]> {
    const s3Client = getS3Client();
    const bucketName = getBucketName();

    let correctedPattern = pattern;
    if (basePrefix === GLOBAL_PREFIX && pattern.startsWith('global/')) {
        correctedPattern = pattern.replace('global/', '');
        console.log(`Corrected pattern from ${pattern} to ${correctedPattern}`);
    }
    if (!correctedPattern.includes('*') && !correctedPattern.includes('?') &&
        !correctedPattern.includes('[') && !correctedPattern.includes('(') &&
        !correctedPattern.includes('|')) {
        correctedPattern = `.*${correctedPattern}.*`;
        console.log(`Added wildcards to pattern: ${correctedPattern}`);
    }

    const searchPrefix = basePrefix;
    const prefixMatch = correctedPattern.match(/^([^\\.\*\+\?\|\(\)\[\]\{\}^$]+)/);
    if (prefixMatch && prefixMatch[1]) {
        console.log(`Found literal prefix in pattern: ${prefixMatch[1]}, but keeping base prefix for broader search`);
    }
    console.log(`Searching in S3 with prefix: ${searchPrefix}`);

    const matchingFiles: string[] = [];
    let continuationToken: string | undefined;

    do {
        try {
            const listCommonPrefixesResponse = await s3Client.send(new ListObjectsV2Command({
                Bucket: bucketName, Prefix: searchPrefix, MaxKeys: 1000,
                Delimiter: '/', ContinuationToken: continuationToken
            }));

            const matchingPrefixes = (listCommonPrefixesResponse.CommonPrefixes || [])
                .filter(item => {
                    if (!item.Prefix) return false;
                    const relativePath = item.Prefix.replace(basePrefix, '');
                    return fileMatchesPattern(relativePath, correctedPattern);
                });

            if (matchingPrefixes.length === 0 && matchingFiles.length === 0) {
                matchingPrefixes.push({ Prefix: searchPrefix });
            }
            console.log('Matching Prefixes: ', matchingPrefixes);

            for (const item of matchingPrefixes) {
                const listFilesCommandResult = await s3Client.send(new ListObjectsV2Command({
                    Bucket: bucketName, Prefix: item.Prefix, MaxKeys: 1000,
                }));
                (listFilesCommandResult.Contents || []).forEach(fileItem => {
                    if (!fileItem.Key) return;
                    const relativePath = fileItem.Key.replace(basePrefix, '');
                    if (fileMatchesPattern(relativePath, correctedPattern)) {
                        matchingFiles.push(fileItem.Key);
                    }
                });
            }
            continuationToken = listCommonPrefixesResponse.NextContinuationToken;
        } catch (error) {
            console.error(`Error finding files matching pattern in S3: ${error}`);
            throw error;
        }
    } while (continuationToken);

    if (matchingFiles.length === 0) {
        try {
            const sampleCommand = new ListObjectsV2Command({ Bucket: bucketName, Prefix: basePrefix, MaxKeys: 20 });
            const sampleResponse = await s3Client.send(sampleCommand);
            const sampleFiles = (sampleResponse.Contents || [])
                .filter(item => { const key = item.Key as string; return !key.endsWith('/') && !key.endsWith('.s3meta'); })
                .map(item => (item.Key as string).replace(basePrefix, ''));
            if (sampleFiles.length > 0) {
                console.log(`No files matched pattern "${correctedPattern}", but here are some available files:`);
                sampleFiles.forEach(file => console.log(`- ${file}`));
            } else {
                console.log(`No files found in directory ${basePrefix}`);
            }
        } catch (error) { console.error(`Error listing sample files: ${error}`); }
    }
    return matchingFiles;
}


// Tool: Search files
const searchFilesTool = {
    name: 'search-files',
    config: {
        title: 'Search Files',
        description: `Search for files matching a regex pattern across user and global storage.
File pattern examples:
- ".*\\.txt$" - all text files
- "data/.*" - all files in the data directory
- "15_9_19_A" - files containing "15_9_19_A" anywhere in the path
The pattern is automatically adjusted to improve matching.`,
        inputSchema: searchFilesSchema,
    },
    handler: async (params: { filePattern: string; maxFiles?: number; includeGlobal?: boolean }) => {
        try {
            const matchingFiles: string[] = [];
            const userFiles = await findFilesMatchingPattern(getUserPrefix(), params.filePattern);
            matchingFiles.push(...userFiles);

            if (params.includeGlobal !== false) {
                const globalWellFiles = await findFilesMatchingPattern(GLOBAL_PREFIX + 'well-files/', params.filePattern);
                matchingFiles.push(...globalWellFiles);
                const globalProductionFiles = await findFilesMatchingPattern(GLOBAL_PREFIX + 'production-data/', params.filePattern);
                matchingFiles.push(...globalProductionFiles);
            }

            const formattedFiles = matchingFiles.map(fileKey => {
                if (fileKey.startsWith(GLOBAL_PREFIX)) return `global/${fileKey.substring(GLOBAL_PREFIX.length)}`;
                return fileKey.substring(getUserPrefix().length);
            });

            const maxFiles = params.maxFiles || 100;
            const limitedFiles = formattedFiles.slice(0, maxFiles);
            const hasMore = formattedFiles.length > maxFiles;

            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    files: limitedFiles, count: limitedFiles.length,
                    totalCount: formattedFiles.length, hasMore, pattern: params.filePattern,
                    message: hasMore
                        ? `Found ${formattedFiles.length} files, showing first ${maxFiles}. Use a more specific pattern to narrow results.`
                        : `Found ${formattedFiles.length} files.`
                }) }]
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    error: `Error searching files: ${message}`,
                    suggestion: "Check the file pattern and try again with a simpler pattern"
                }) }], isError: true
            };
        }
    },
};

interface ParsedHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}

function parseUnifiedDiff(diff: string): ParsedHunk[] {
    const hunks: ParsedHunk[] = [];
    let currentHunk: ParsedHunk | null = null;

    for (const line of diff.split('\n')) {
        const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkHeader) {
            if (currentHunk) hunks.push(currentHunk);
            currentHunk = {
                oldStart: parseInt(hunkHeader[1] ?? '1', 10),
                oldLines: parseInt(hunkHeader[2] ?? '1', 10),
                newStart: parseInt(hunkHeader[3] ?? '1', 10),
                newLines: parseInt(hunkHeader[4] ?? '1', 10),
                lines: [],
            };
        } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
            currentHunk.lines.push(line);
        }
    }
    if (currentHunk) hunks.push(currentHunk);
    return hunks;
}

function applyHunks(original: string, hunks: ParsedHunk[]): string {
    const lines = original.split('\n');
    // Track offset as we apply hunks that change the line count
    let offset = 0;

    for (const hunk of hunks) {
        // Find the hunk's old-file start, adjusted for prior hunks
        let applyAt = hunk.oldStart - 1 + offset;

        // Fuzzy search: if context lines don't match at the expected position,
        // scan nearby to find the best match
        const contextLines = hunk.lines
            .filter(l => l.startsWith(' '))
            .map(l => l.slice(1));

        if (contextLines.length > 0) {
            const searchRadius = 10;
            let bestMatch = applyAt;
            let bestScore = -1;

            for (let delta = -searchRadius; delta <= searchRadius; delta++) {
                const candidate = applyAt + delta;
                if (candidate < 0) continue;
                let score = 0;
                for (let i = 0; i < contextLines.length; i++) {
                    if (lines[candidate + i] === contextLines[i]) score++;
                }
                if (score > bestScore) { bestScore = score; bestMatch = candidate; }
            }
            applyAt = bestMatch;
        }

        // Build the replacement lines from the hunk
        const removedCount = hunk.lines.filter(l => l.startsWith('-') || l.startsWith(' ')).length;
        const additions: string[] = [];
        for (const l of hunk.lines) {
            if (l.startsWith('+') || l.startsWith(' ')) {
                additions.push(l.slice(1));
            }
        }

        lines.splice(applyAt, removedCount, ...additions);
        offset += additions.length - removedCount;
    }

    return lines.join('\n');
}

// Tool: Apply diff
const applyDiffTool = {
    name: 'apply-diff',
    config: {
        title: 'Apply Diff',
        description: `Applies a unified diff patch to an existing file in session storage.
Use this to make targeted edits to a file without rewriting the entire contents.
Global files (global/filename) are read-only and cannot be patched.

The diff must be in standard unified diff format:
--- a/filename
+++ b/filename
@@ -lineStart,lineCount +lineStart,lineCount @@
 context line
-removed line
+added line
 context line`,
        inputSchema: applyDiffSchema,
    },
    handler: async (params: { filename: string; diff: string }) => {
        const { filename, diff } = params;
        try {
            const targetPath = path.normalize(filename);
            if (targetPath.startsWith("..")) {
                return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "Invalid file path. Cannot access files outside project root directory." }) }], isError: true };
            }
            if (targetPath.startsWith("global/") && !targetPath.startsWith("global/notes/")) {
                return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "Cannot patch files in the global directory. Global files are read-only." }) }], isError: true };
            }

            const prefix = getS3KeyPrefix(targetPath);
            const s3Key = path.posix.join(prefix, targetPath);

            let existingContent: string;
            try {
                const result = await readS3Object({ key: s3Key, maxBytes: 0, startAtByte: 0 });
                existingContent = result.content;
            } catch (error: unknown) {
                const s3Error = error as { name?: string };
                if (s3Error.name === 'NoSuchKey') {
                    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `File not found: ${filename}` }) }], isError: true };
                }
                throw error;
            }

            const hunks = parseUnifiedDiff(diff);
            if (hunks.length === 0) {
                return { content: [{ type: 'text' as const, text: JSON.stringify({ error: "No valid hunks found in the provided diff." }) }], isError: true };
            }

            const patched = applyHunks(existingContent, hunks);
            await writeS3Object(s3Key, patched);

            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    success: true,
                    message: `Patch applied successfully to ${filename}`,
                    hunksApplied: hunks.length,
                }) }]
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Error applying diff: ${message}` }) }], isError: true };
        }
    },
};

export const allS3Tools = [
    listFilesTool,
    // readFileTool,
    // writeFileTool,
    updateFileTool,
    applyDiffTool,
    // textToTableTool,
    searchFilesTool,
];
