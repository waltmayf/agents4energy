/**
 * executeMapLayerQuery handler
 * Executes Athena query and converts results to GeoJSON
 */

import type { Schema } from '../../data/resource';
import { StartQueryExecutionCommand } from '@aws-sdk/client-athena';
import { athena, getQueryResults } from './utils/athenaClient';
import type { GeoJsonMappingConfig } from './utils/types';

export const handler: Schema['executeMapLayerQuery']['functionHandler'] = async (event) => {
  console.log('executeMapLayerQuery event:', JSON.stringify(event, null, 2));
  
  const { queryString, database, geoJsonMapping } = event.arguments;
  
  try {
    console.log('Executing map layer query:', { queryString, database, geoJsonMapping });
    
    // Parse geoJsonMapping if it's a string
    const mapping: GeoJsonMappingConfig = typeof geoJsonMapping === 'string' 
      ? JSON.parse(geoJsonMapping) 
      : geoJsonMapping;
    
    // Validate mapping configuration
    if (!mapping.geometryType) {
      throw new Error('geoJsonMapping must include geometryType');
    }
    
    if (mapping.geometryType === 'Point' && (!mapping.longitudeField || !mapping.latitudeField)) {
      throw new Error('Point geometry requires longitudeField and latitudeField');
    }
    
    if ((mapping.geometryType === 'LineString' || mapping.geometryType === 'Polygon') && !mapping.coordinatesField) {
      throw new Error(`${mapping.geometryType} geometry requires coordinatesField`);
    }
    
    // Execute the query
    const params = {
      QueryString: queryString,
      QueryExecutionContext: { Database: database },
      WorkGroup: process.env.ATHENA_WORKGROUP,
    };
    
    const startCommand = new StartQueryExecutionCommand(params);
    const startResponse = await athena.send(startCommand);
    
    if (!startResponse.QueryExecutionId) {
      throw new Error('Failed to start query execution');
    }
    
    console.log('Query started with ID:', startResponse.QueryExecutionId);
    
    // Poll for query completion (with timeout)
    const maxAttempts = 60; // 2 minutes max
    let attempts = 0;
    let queryResult = null;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      queryResult = await getQueryResults(startResponse.QueryExecutionId);
      
      if (queryResult.status === 'SUCCEEDED') {
        break;
      } else if (queryResult.status === 'FAILED' || queryResult.status === 'CANCELLED') {
        throw new Error(queryResult.error || 'Query failed');
      }
      
      attempts++;
    }
    
    if (!queryResult || queryResult.status !== 'SUCCEEDED') {
      throw new Error('Query timeout: Query did not complete within 2 minutes');
    }
    
    if (!queryResult.data || queryResult.data.length === 0) {
      return {
        success: true,
        geoJsonData: { type: 'FeatureCollection', features: [] },
        rowCount: 0,
      };
    }
    
    // Convert query results to GeoJSON
    const features = queryResult.data
      .map((row: any) => {
        try {
          let geometry: any;
          
          if (mapping.geometryType === 'Point') {
            const lon = parseFloat(row[mapping.longitudeField!]);
            const lat = parseFloat(row[mapping.latitudeField!]);
            
            if (isNaN(lon) || isNaN(lat)) {
              console.warn('Invalid coordinates in row:', row);
              return null;
            }
            
            geometry = {
              type: 'Point',
              coordinates: [lon, lat]
            };
          } else if (mapping.geometryType === 'LineString' || mapping.geometryType === 'Polygon') {
            const coordsString = row[mapping.coordinatesField!];
            if (!coordsString) {
              console.warn('Missing coordinates field in row:', row);
              return null;
            }
            
            // Parse coordinates (expecting JSON array)
            const coordinates = JSON.parse(coordsString);
            geometry = {
              type: mapping.geometryType,
              coordinates
            };
          }
          
          // Extract properties
          const properties: Record<string, any> = {};
          if (mapping.propertyFields && mapping.propertyFields.length > 0) {
            mapping.propertyFields.forEach(field => {
              if (field in row) {
                properties[field] = row[field];
              }
            });
          } else {
            // Include all fields except coordinate fields
            Object.keys(row).forEach(key => {
              if (key !== mapping.longitudeField && 
                  key !== mapping.latitudeField && 
                  key !== mapping.coordinatesField) {
                properties[key] = row[key];
              }
            });
          }
          
          return {
            type: 'Feature',
            geometry,
            properties
          };
        } catch (error) {
          console.error('Error converting row to feature:', error, row);
          return null;
        }
      })
      .filter((feature: any) => feature !== null);
    
    const geoJsonData = {
      type: 'FeatureCollection',
      features
    };
    
    console.log(`Successfully converted ${features.length} rows to GeoJSON features`);
    
    return {
      success: true,
      geoJsonData,
      rowCount: features.length,
    };
    
  } catch (error) {
    console.error('Error executing map layer query:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
