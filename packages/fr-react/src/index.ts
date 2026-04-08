/**
 * @rit/fr-react — React component plugin for fs-rit.
 *
 * Materializes component entities into TSX files.
 */

import type { FrPlugin } from '../../fs-rit/src/plugin.js';
import { materializeComponents, readComponents, writeComponent, setSymbols } from './components.js';

export { readComponents, materializeComponents, writeComponent } from './components.js';
export type { ComponentEntity } from './components.js';

/**
 * React component plugin for fs-rit.
 */
export function reactPlugin(): FrPlugin {
  return {
    name: 'react',

    symbols: {
      // React hooks
      useState: { source: 'react', isDefault: false },
      useEffect: { source: 'react', isDefault: false },
      useCallback: { source: 'react', isDefault: false },
      useMemo: { source: 'react', isDefault: false },
      useRef: { source: 'react', isDefault: false },
      useContext: { source: 'react', isDefault: false },
      useReducer: { source: 'react', isDefault: false },
      useLayoutEffect: { source: 'react', isDefault: false },
      useImperativeHandle: { source: 'react', isDefault: false },
      useDebugValue: { source: 'react', isDefault: false },
      useDeferredValue: { source: 'react', isDefault: false },
      useTransition: { source: 'react', isDefault: false },
      useId: { source: 'react', isDefault: false },
      useSyncExternalStore: { source: 'react', isDefault: false },
      useInsertionEffect: { source: 'react', isDefault: false },
      // React utilities
      Fragment: { source: 'react', isDefault: false },
      Suspense: { source: 'react', isDefault: false },
      lazy: { source: 'react', isDefault: false },
      memo: { source: 'react', isDefault: false },
      forwardRef: { source: 'react', isDefault: false },
      createContext: { source: 'react', isDefault: false },
      // React types
      ReactNode: { source: 'react', isDefault: false },
      FC: { source: 'react', isDefault: false },
      PropsWithChildren: { source: 'react', isDefault: false },
    },

    configure(allSymbols) {
      setSymbols(allSymbols);
    },

    async materialize(repo, rootDir) {
      return materializeComponents(repo, rootDir);
    },
  };
}
