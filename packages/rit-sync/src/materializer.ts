import type { EntityStore } from '../../../packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema, VariableSchema } from './schemas.js';
import { JsonFileSchema } from './plugins/json.js';
import type { LanguagePlugin, FileEntities } from './types.js';

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

    const entities: FileEntities = {
      root: module,
      children: {
        fn: allFunctions,
        typ: allTypes,
        var: allVariables,
      },
    };

    return plugin.materialize(entities);
  }

  /** Materialize a JSON file from the entity store. */
  async materializeJson(jsonPath: string, plugin: LanguagePlugin): Promise<string> {
    const entity = await this.entityStore.get(JsonFileSchema, { path: jsonPath });
    if (!entity) {
      throw new Error(`JSON file '${jsonPath}' not found in store`);
    }

    const entities: FileEntities = {
      root: entity,
      children: {},
    };

    return plugin.materialize(entities);
  }

  /** List all JSON file paths in the store. */
  async listJsonFiles(): Promise<string[]> {
    const entities = await this.entityStore.list(JsonFileSchema);
    return entities.map(e => e.path as string);
  }
}
