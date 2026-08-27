import { z } from 'zod'
import { getConfiguredAmplifyClient } from './amplifyUtils'
import { getCurrentChatSessionId } from '../context'

// GraphQL mutation strings for map layers
const mutations = {
  createMapLayer: /* GraphQL */ `
    mutation CreateMapLayer($input: CreateMapLayerInput!) {
      createMapLayer(input: $input) {
        id
        chatSessionId
        name
        type
        visible
        order
        createdAt
      }
    }
  `,
  updateMapLayer: /* GraphQL */ `
    mutation UpdateMapLayer($input: UpdateMapLayerInput!) {
      updateMapLayer(input: $input) {
        id
        chatSessionId
        name
        type
        visible
        order
        updatedAt
      }
    }
  `,
  deleteMapLayer: /* GraphQL */ `
    mutation DeleteMapLayer($input: DeleteMapLayerInput!) {
      deleteMapLayer(input: $input) {
        id
      }
    }
  `,
  updateActionItem: /* GraphQL */ `
    mutation UpdateActionItem($input: UpdateActionItemInput!) {
      updateActionItem(input: $input) {
        id
        alertId
        type
        action
        description
        expectedValue
        risk
        status
        source
        updatedAt
      }
    }
  `,
  updateWorkoverJob: /* GraphQL */ `
    mutation UpdateWorkoverJob($input: UpdateWorkoverJobInput!) {
      updateWorkoverJob(input: $input) {
        id
        wellName
        location
        jobType
        priority
        status
        estimatedDuration
        scheduledDate
        rigAssigned
        description
        estimatedCost
        financialMetrics {
          incrementalOilBOPD
          incrementalGasMCFD
          presentValue
          rateOfReturn
          paybackMonths
        }
        updatedAt
      }
    }
  `,
}

const queries = {
  listMapLayers: /* GraphQL */ `
    query ListMapLayerByChatSessionIdAndOrder(
      $chatSessionId: ID!
      $order: ModelIntKeyConditionInput
      $sortDirection: ModelSortDirection
      $filter: ModelMapLayerFilterInput
      $limit: Int
      $nextToken: String
    ) {
      listMapLayerByChatSessionIdAndOrder(
        chatSessionId: $chatSessionId
        order: $order
        sortDirection: $sortDirection
        filter: $filter
        limit: $limit
        nextToken: $nextToken
      ) {
        items {
          id
          chatSessionId
          name
          type
          visible
          athenaQuery
          athenaDatabase
          geoJsonMapping
          queryRefreshInterval
          lastQueryExecutedAt
          queryError
          style
          order
          description
          source
          createdAt
          updatedAt
        }
        nextToken
      }
    }
  `,
}

// Create Map Layer Tool
const createMapLayerTool = {
  name: 'create-map-layer',
  config: {
    title: 'Create Map Layer',
    description:
      'Create a query-based map layer for the current chat session. Executes an Athena SQL query to generate GeoJSON. Query is validated before creation. Chat session ID is automatic.',
    inputSchema: z.object({
      name: z.string().describe('Layer display name'),
      type: z
        .enum(['point', 'line', 'polygon', 'heatmap', 'geojson'])
        .describe('Geometry type'),
      athenaQuery: z.string().describe('SQL query for Athena'),
      athenaDatabase: z.string().describe('Athena database name'),
      geoJsonMapping: z
        .object({
          geometryType: z.enum(['Point', 'LineString', 'Polygon']),
          longitudeField: z.string().optional().describe('Longitude column (for Point)'),
          latitudeField: z.string().optional().describe('Latitude column (for Point)'),
          coordinatesField: z.string().optional().describe('Coordinates column (for LineString/Polygon)'),
          propertyFields: z.array(z.string()).optional().describe('Columns for feature properties'),
        })
        .describe('Query-to-GeoJSON mapping'),
      queryRefreshInterval: z.number().optional().describe('Auto-refresh minutes (0=manual)'),
      style: z.string().optional().describe('JSON string of style config: {color, opacity, radius, width, strokeColor, strokeWidth, intensity, colorScale: {type, property, stops, categories, defaultColor}, radiusScale: {property, min, max, minRadius, maxRadius}, tooltip: {title, fields: [{property, label, format, decimals, unit}]}}'),
      order: z.number().optional().describe('Z-index order'),
      description: z.string().optional(),
      source: z.string().optional().describe('Data source identifier'),
    }),
  },
  handler: async (params: any) => {
    try {
      const amplifyClient = getConfiguredAmplifyClient()

      // Get chatSessionId from request context
      const chatSessionId = getCurrentChatSessionId()
      if (!chatSessionId) {
        throw new Error('chatSessionId is required but was not provided')
      }

      // Validate required fields
      if (!params.athenaQuery) {
        throw new Error('athenaQuery is required')
      }

      if (!params.athenaDatabase) {
        throw new Error('athenaDatabase is required')
      }

      if (!params.geoJsonMapping) {
        throw new Error('geoJsonMapping is required')
      }

      // Execute the query to validate it
      console.log('Validating query for map layer:', params.name)
      const queryResult = await amplifyClient.graphql(
        {
          query: /* GraphQL */ `
            mutation ExecuteMapLayerQuery($queryString: String!, $database: String!, $geoJsonMapping: AWSJSON!) {
              executeMapLayerQuery(queryString: $queryString, database: $database, geoJsonMapping: $geoJsonMapping) {
                success
                geoJsonData
                error
                rowCount
              }
            }
          `,
          variables: {
            queryString: params.athenaQuery,
            database: params.athenaDatabase,
            geoJsonMapping: JSON.stringify(params.geoJsonMapping),
          },
        },
        { authMode: 'userPool' }
      )

      const queryData = 'data' in queryResult ? queryResult.data : null
      if (!queryData || !queryData.executeMapLayerQuery.success) {
        const errorMsg = queryData?.executeMapLayerQuery.error || 'Query validation failed'
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: 'Query validation failed',
                  message: errorMsg,
                  query: params.athenaQuery,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        }
      }

      console.log(`Query validated successfully: ${queryData.executeMapLayerQuery.rowCount} features generated`)

      const input = {
        chatSessionId,
        name: params.name,
        type: params.type,
        visible: true,
        athenaQuery: params.athenaQuery,
        athenaDatabase: params.athenaDatabase,
        geoJsonMapping: JSON.stringify(params.geoJsonMapping),
        queryRefreshInterval: params.queryRefreshInterval || 0,
        style: params.style || null,
        order: params.order || 0,
        description: params.description || null,
        source: params.source || 'ai-created',
      }

      const result = await amplifyClient.graphql(
        {
          query: mutations.createMapLayer,
          variables: { input },
        },
        { authMode: 'userPool' }
      )

      const data = 'data' in result ? result.data : null
      if (!data) {
        throw new Error('No data returned from GraphQL mutation')
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                layer: data.createMapLayer,
                message: `Created query-based map layer "${params.name}" with query: ${params.athenaQuery.substring(0, 100)}... The query will be executed automatically by the frontend.`,
              },
              null,
              2
            ),
          },
        ],
      }
    } catch (error) {
      let errorMessage: string
      if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = JSON.stringify(error)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                error: 'Failed to create map layer',
                message: errorMessage,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      }
    }
  },
}

// Update Map Layer Tool
const updateMapLayerTool = {
  name: 'update-map-layer',
  config: {
    title: 'Update Map Layer',
    description: 'Update an existing map layer properties.',
    inputSchema: z.object({
      id: z.string().describe('Map layer ID'),
      name: z.string().optional(),
      type: z.enum(['point', 'line', 'polygon', 'heatmap', 'geojson']).optional(),
      visible: z.boolean().optional(),
      athenaQuery: z.string().optional(),
      athenaDatabase: z.string().optional(),
      geoJsonMapping: z
        .object({
          geometryType: z.enum(['Point', 'LineString', 'Polygon']),
          longitudeField: z.string().optional(),
          latitudeField: z.string().optional(),
          coordinatesField: z.string().optional(),
          propertyFields: z.array(z.string()).optional(),
        })
        .optional(),
      queryRefreshInterval: z.number().optional(),
      style: z.string().optional().describe('JSON string of style config'),
      order: z.number().optional(),
      description: z.string().optional(),
    }),
  },
  handler: async (params: any) => {
    try {
      const amplifyClient = getConfiguredAmplifyClient()

      // Build input object with only provided fields
      const input: Record<string, unknown> = { id: params.id }
      if (params.name !== undefined) input.name = params.name
      if (params.type !== undefined) input.type = params.type
      if (params.visible !== undefined) input.visible = params.visible
      if (params.athenaQuery !== undefined) input.athenaQuery = params.athenaQuery
      if (params.athenaDatabase !== undefined) input.athenaDatabase = params.athenaDatabase
      if (params.geoJsonMapping !== undefined) input.geoJsonMapping = JSON.stringify(params.geoJsonMapping)
      if (params.queryRefreshInterval !== undefined) input.queryRefreshInterval = params.queryRefreshInterval
      if (params.style !== undefined) input.style = params.style
      if (params.order !== undefined) input.order = params.order
      if (params.description !== undefined) input.description = params.description

      const result = await amplifyClient.graphql(
        {
          query: mutations.updateMapLayer,
          variables: { input },
        },
        { authMode: 'userPool' }
      )

      const data = 'data' in result ? result.data : null
      if (!data) {
        throw new Error('No data returned from GraphQL mutation')
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                layer: data.updateMapLayer,
                message: `Updated map layer ${params.id}`,
              },
              null,
              2
            ),
          },
        ],
      }
    } catch (error) {
      let errorMessage: string
      if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = JSON.stringify(error)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                error: 'Failed to update map layer',
                message: errorMessage,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      }
    }
  },
}

// Delete Map Layer Tool
const deleteMapLayerTool = {
  name: 'delete-map-layer',
  config: {
    title: 'Delete Map Layer',
    description: 'Delete a map layer.',
    inputSchema: z.object({
      id: z.string().describe('Map layer ID'),
    }),
  },
  handler: async (params: any) => {
    try {
      const amplifyClient = getConfiguredAmplifyClient()

      await amplifyClient.graphql(
        {
          query: mutations.deleteMapLayer,
          variables: { input: { id: params.id } },
        },
        { authMode: 'userPool' }
      )

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                message: `Deleted map layer ${params.id}`,
              },
              null,
              2
            ),
          },
        ],
      }
    } catch (error) {
      let errorMessage: string
      if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = JSON.stringify(error)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                error: 'Failed to delete map layer',
                message: errorMessage,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      }
    }
  },
}

// List Map Layers Tool
const listMapLayersTool = {
  name: 'list-map-layers',
  config: {
    title: 'List Map Layers',
    description: 'List map layers for the current chat session.',
    inputSchema: z.object({
      limit: z.number().optional(),
      nextToken: z.string().optional(),
    }),
  },
  handler: async (params: any) => {
    try {
      const amplifyClient = getConfiguredAmplifyClient()

      // Get chatSessionId from request context
      const chatSessionId = getCurrentChatSessionId()
      if (!chatSessionId) {
        throw new Error('chatSessionId is required but was not provided')
      }

      console.log(`[list-map-layers] Querying with chatSessionId: ${chatSessionId}`)

      const result = await amplifyClient.graphql(
        {
          query: queries.listMapLayers,
          variables: {
            chatSessionId,
            sortDirection: 'ASC',
            limit: params.limit,
            nextToken: params.nextToken,
          },
        },
        { authMode: 'userPool' }
      )

      const data = 'data' in result ? result.data : null
      if (!data) {
        throw new Error('No data returned from GraphQL query')
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                layers: data.listMapLayerByChatSessionIdAndOrder.items,
                nextToken: data.listMapLayerByChatSessionIdAndOrder.nextToken,
                count: data.listMapLayerByChatSessionIdAndOrder.items.length,
              },
              null,
              2
            ),
          },
        ],
      }
    } catch (error) {
      let errorMessage: string
      if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = JSON.stringify(error)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                error: 'Failed to list map layers',
                message: errorMessage,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      }
    }
  },
}

// Update Action Item Status Tool
const updateActionItemTool = {
  name: 'update-action-item-status',
  config: {
    title: 'Update Action Item Status',
    description: 'Update action item status (approve, reject, or defer).',
    inputSchema: z.object({
      id: z.string().describe('Action item ID'),
      status: z.enum(['pending', 'approved', 'rejected', 'deferred']),
    }),
  },
  handler: async (params: any) => {
    try {
      const amplifyClient = getConfiguredAmplifyClient()

      const input = {
        id: params.id,
        status: params.status,
      }

      const result = await amplifyClient.graphql(
        {
          query: mutations.updateActionItem,
          variables: { input },
        },
        { authMode: 'userPool' }
      )

      const data = 'data' in result ? result.data : null
      if (!data) {
        throw new Error('No data returned from GraphQL mutation')
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                actionItem: data.updateActionItem,
                message: `Updated action item status to "${params.status}": ${data.updateActionItem.action}`,
              },
              null,
              2
            ),
          },
        ],
      }
    } catch (error) {
      let errorMessage: string
      if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = JSON.stringify(error)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                error: 'Failed to update action item status',
                message: errorMessage,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      }
    }
  },
}

// Update Workover Job Tool
const updateWorkoverJobTool = {
  name: 'update-workover-job',
  config: {
    title: 'Update Workover Job',
    description: 'Update workover job details.',
    inputSchema: z.object({
      id: z.string().describe('Workover job ID'),
      status: z.enum(['queued', 'inProgress', 'completed', 'delayed']).optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      scheduledDate: z.string().optional().describe('YYYY-MM-DD'),
      rigAssigned: z.string().optional(),
      estimatedDuration: z.string().optional(),
      description: z.string().optional(),
    }),
  },
  handler: async (params: any) => {
    try {
      const amplifyClient = getConfiguredAmplifyClient()

      // Build input object with only provided fields
      const input: Record<string, unknown> = { id: params.id }
      if (params.status !== undefined) input.status = params.status
      if (params.priority !== undefined) input.priority = params.priority
      if (params.scheduledDate !== undefined) input.scheduledDate = params.scheduledDate
      if (params.rigAssigned !== undefined) input.rigAssigned = params.rigAssigned
      if (params.estimatedDuration !== undefined) input.estimatedDuration = params.estimatedDuration
      if (params.description !== undefined) input.description = params.description

      const result = await amplifyClient.graphql(
        {
          query: mutations.updateWorkoverJob,
          variables: { input },
        },
        { authMode: 'userPool' }
      )

      const data = 'data' in result ? result.data : null
      if (!data) {
        throw new Error('No data returned from GraphQL mutation')
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: true,
                workoverJob: data.updateWorkoverJob,
                message: `Updated workover job: ${data.updateWorkoverJob.wellName} - ${data.updateWorkoverJob.description}`,
              },
              null,
              2
            ),
          },
        ],
      }
    } catch (error) {
      let errorMessage: string
      if (error instanceof Error) {
        errorMessage = error.message
      } else {
        errorMessage = JSON.stringify(error)
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                error: 'Failed to update workover job',
                message: errorMessage,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      }
    }
  },
}

export const allMutationTools = [
  createMapLayerTool,
  updateMapLayerTool,
  deleteMapLayerTool,
  listMapLayersTool,
  updateActionItemTool,
  updateWorkoverJobTool,
]
