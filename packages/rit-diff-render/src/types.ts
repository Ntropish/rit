export interface FieldChange {
  field: string;
  type: 'added' | 'removed' | 'modified';
  oldValue?: string;
  newValue?: string;
}

export interface EntityDiff {
  key: string;
  prefix: string;
  identity: string;
  fieldChanges: FieldChange[];
}

export interface SemanticChange {
  entityType: string;
  entityIdentity: string;
  changeType: 'created' | 'deleted' | 'modified' | 'renamed' | 'moved';
  fields?: {
    field: string;
    from?: string;
    to?: string;
  }[];
  renamedFrom?: string;
}
