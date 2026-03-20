export interface EntitySchema {
  prefix: string;
  fields: Record<string, FieldDef>;
  identity: string[];
}

export interface FieldDef {
  type: 'string' | 'number' | 'boolean' | 'ref' | 'ref[]';
  required?: boolean;
  refTarget?: string;
}
