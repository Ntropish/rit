import type { EntityStore } from '../../../packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema, VariableSchema } from './schemas.js';
import type { LanguagePlugin, ModuleEntities } from './types.js';

export class FileMaterializer {
  constructor(private entityStore: EntityStore) {}

  /** Materialize a module from the entity store back to source text. */
  async materialize(modulePath: string, plugin: LanguagePlugin): Promise<string> {
    const moduleKey = `mod:${modulePath}`;

    // Get module entity
    const module = await this.entityStore.get(ModuleSchema, { path: modulePath });
    if (!module) {
      throw new Error(`Module '${modulePath}' not found in store`);
    }

    // Get functions for this module
    const allFunctions = await this.entityStore.list(FunctionSchema, { module: moduleKey });

    // Get types for this module
    const allTypes = await this.entityStore.list(TypeDefSchema, { module: moduleKey });

    // Get variables for this module
    const allVariables = await this.entityStore.list(VariableSchema, { module: moduleKey });

    const entities: ModuleEntities = {
      module,
      functions: allFunctions,
      types: allTypes,
      variables: allVariables,
    };

    return plugin.materialize(entities);
  }
}
