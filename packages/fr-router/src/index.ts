/**
 * @rit/fr-router — TanStack Router plugin for fs-rit.
 *
 * Materializes route entities into a TanStack Router configuration file.
 */

import type { FrPlugin } from '../../fs-rit/src/plugin.js';
import { materializeRouter, readRoutes, writeRoute } from './router.js';

export { readRoutes, materializeRouter, writeRoute } from './router.js';
export type { RouteEntity } from './router.js';

/**
 * TanStack Router plugin for fs-rit.
 */
export function routerPlugin(): FrPlugin {
  return {
    name: 'router',

    symbols: {
      Link: { source: '@tanstack/react-router', isDefault: false },
      Outlet: { source: '@tanstack/react-router', isDefault: false },
      useNavigate: { source: '@tanstack/react-router', isDefault: false },
      useParams: { source: '@tanstack/react-router', isDefault: false },
      useSearch: { source: '@tanstack/react-router', isDefault: false },
      useRouter: { source: '@tanstack/react-router', isDefault: false },
      useMatch: { source: '@tanstack/react-router', isDefault: false },
      useLoaderData: { source: '@tanstack/react-router', isDefault: false },
    },

    async materialize(repo, rootDir) {
      const routerFile = await materializeRouter(repo, rootDir);
      return routerFile ? [routerFile] : [];
    },
  };
}
