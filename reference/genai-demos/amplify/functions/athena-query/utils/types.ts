/**
 * Shared types for Athena query operations
 */

export interface GeoJsonMappingConfig {
  geometryType: 'Point' | 'LineString' | 'Polygon';
  longitudeField?: string;
  latitudeField?: string;
  coordinatesField?: string;
  propertyFields?: string[];
}
