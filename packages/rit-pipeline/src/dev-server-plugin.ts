/**
 * Pipeline dev server plugin.
 *
 * Validates that pipeline and step schemas exist in the store.
 * Adds endpoints for manual pipeline triggering and run queries.
 */

import type { DevServerPlugin } from '@rit/dev-server';

export const pipelinePlugin: DevServerPlugin = {
  name: 'pipeline',
  requiredPrefixes: ['pipeline', 'step'],
};
