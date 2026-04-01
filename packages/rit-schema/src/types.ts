export interface EntitySchema {
  prefix: string;
  fields: Record<string, FieldDef>;
  identity: string[];
}

export interface FieldDef {
  type: 'string' | 'number' | 'boolean' | 'ref' | 'ref[]' | 'enum';
  required?: boolean;
  refTarget?: string;
  label?: string;
  format?: string;
  min?: string;
  max?: string;
  values?: string;
  default?: string;
}
