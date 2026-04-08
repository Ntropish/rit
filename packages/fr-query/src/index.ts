/**
 * @rit/fr-query — TanStack Query plugin for fs-rit.
 *
 * Materializes query and mutation entities into typed hooks.
 * Entity fields map 1:1 to TanStack Query options.
 */

import type { FrPlugin } from '../../fs-rit/src/plugin.js';
import { materializeQueries, readQueries, readMutations, writeQuery, writeMutation } from './queries.js';

export { readQueries, readMutations, materializeQueries, writeQuery, writeMutation } from './queries.js';

/**
 * TanStack Query plugin for fs-rit.
 */
export function queryPlugin(): FrPlugin {
  return {
    name: 'query',

    symbols: {
      useQuery: { source: '@tanstack/react-query', isDefault: false },
      useMutation: { source: '@tanstack/react-query', isDefault: false },
      useQueryClient: { source: '@tanstack/react-query', isDefault: false },
      QueryClient: { source: '@tanstack/react-query', isDefault: false },
      QueryClientProvider: { source: '@tanstack/react-query', isDefault: false },
    },

    async materialize(repo, rootDir) {
      const file = await materializeQueries(repo, rootDir);
      return file ? [file] : [];
    },
  };
}
