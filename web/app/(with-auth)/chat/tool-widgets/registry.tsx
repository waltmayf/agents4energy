import type { ComponentType } from 'react';
import type { ComponentSpec } from '@/lib/component-spec';
import { TableWidget } from './table-widget';
import { MetricGridWidget } from './metric-grid-widget';

/**
 * Vetted widgets for `ComponentSpec['type']`. To add a widget: create its
 * component (co-located in this folder) and add one entry here — nothing
 * else in the renderer needs to change.
 */
const WIDGET_REGISTRY: { [K in ComponentSpec['type']]: ComponentType<{ spec: Extract<ComponentSpec, { type: K }> }> } = {
  table: TableWidget,
  'metric-grid': MetricGridWidget,
};

export function renderComponentSpec(spec: ComponentSpec) {
  const Widget = WIDGET_REGISTRY[spec.type] as ComponentType<{ spec: ComponentSpec }>;
  return <Widget spec={spec} />;
}
