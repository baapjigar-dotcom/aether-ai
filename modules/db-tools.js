/**
 * NovaOS AI — approval-gated database transaction engine.
 * Destructive operations must target explicit records; collection-wide delete is deliberately unsupported.
 */
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ALLOWED_TOOLS = new Set(['insert_records', 'update_records', 'delete_records', 'create_collection']);

export const DB_TOOL_SCHEMAS = [
  {
    type: 'function', function: {
      name: 'insert_records', description: 'Insert JSON records into a collection after user approval.',
      parameters: { type: 'object', properties: { collection: { type: 'string' }, records: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object' } } }, required: ['collection', 'records'], additionalProperties: false }
    }
  },
  {
    type: 'function', function: {
      name: 'update_records', description: 'Update fields on records matching an exact field/value pair.',
      parameters: { type: 'object', properties: { collection: { type: 'string' }, matchField: { type: 'string' }, matchValue: { type: ['string', 'number'] }, updates: { type: 'object', minProperties: 1 } }, required: ['collection', 'matchField', 'matchValue', 'updates'], additionalProperties: false }
    }
  },
  {
    type: 'function', function: {
      name: 'delete_records', description: 'Delete explicitly named record IDs only. Empty IDs and collection-wide deletion are not supported.',
      parameters: { type: 'object', properties: { collection: { type: 'string' }, ids: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string' } } }, required: ['collection', 'ids'], additionalProperties: false }
    }
  },
  {
    type: 'function', function: {
      name: 'create_collection', description: 'Create a new collection that does not already exist.',
      parameters: { type: 'object', properties: { collection: { type: 'string' }, seedRecords: { type: 'array', maxItems: 50, items: { type: 'object' } } }, required: ['collection'], additionalProperties: false }
    }
  }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function cleanCollectionName(value) {
  return String(value || '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}
function cleanRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const output = {};
  for (const [key, value] of Object.entries(record).slice(0, 40)) {
    if (!key || RESERVED_KEYS.has(key) || key.length > 80) continue;
    output[key] = value;
  }
  return output;
}

export class SmartDbTransactionManager {
  constructor(initialDb, onCommitCallback) {
    this.db = initialDb;
    this.undoStack = [];
    this.pendingProposals = [];
    this.onCommit = onCommitCallback;
  }

  createSnapshot() {
    return clone(this.db);
  }

  proposeToolCall(toolName, args, summaryText) {
    if (!ALLOWED_TOOLS.has(toolName)) throw new TypeError(`Unsupported database tool: ${toolName}`);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Tool arguments must be an object.');
    const proposal = {
      id: `PROP-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
      toolName,
      args: clone(args),
      summaryText: String(summaryText || `${toolName} proposal`).slice(0, 240),
      status: 'pending',
      createdAt: Date.now()
    };
    this.pendingProposals.push(proposal);
    return proposal;
  }

  approveProposal(proposalId) {
    const proposal = this.pendingProposals.find((item) => item.id === proposalId && item.status === 'pending');
    if (!proposal || !ALLOWED_TOOLS.has(proposal.toolName)) return null;

    const { toolName, args } = proposal;
    const collection = cleanCollectionName(args.collection || this.db.activeCollection || 'Default');
    if (!collection || !this.db?.collections || typeof this.db.collections !== 'object') return null;
    const rows = Array.isArray(this.db.collections[collection]) ? this.db.collections[collection] : [];
    let apply;

    if (toolName === 'create_collection') {
      if (Object.prototype.hasOwnProperty.call(this.db.collections, collection)) return null;
      const seed = (Array.isArray(args.seedRecords) ? args.seedRecords : []).slice(0, 50).map(cleanRecord);
      if (seed.some((record) => !record)) return null;
      apply = () => { this.db.collections[collection] = seed; this.db.activeCollection = collection; };
    } else if (toolName === 'insert_records') {
      if (!Array.isArray(args.records) || !args.records.length || args.records.length > 50) return null;
      const existingIds = new Set(rows.map((row) => String(row.id ?? '')));
      const records = args.records.map(cleanRecord);
      if (records.some((record) => !record)) return null;
      for (const record of records) {
        if (record.id == null || String(record.id).trim() === '' || existingIds.has(String(record.id))) return null;
        existingIds.add(String(record.id));
      }
      apply = () => { this.db.collections[collection] = [...records, ...rows]; this.db.activeCollection = collection; };
    } else if (toolName === 'update_records') {
      if (!Array.isArray(this.db.collections[collection]) || !args.matchField || args.matchValue === undefined || args.matchValue === null) return null;
      const updates = cleanRecord(args.updates);
      if (!updates) return null;
      delete updates.id;
      const keys = Object.keys(updates);
      if (!keys.length || keys.some((key) => RESERVED_KEYS.has(key))) return null;
      const value = String(args.matchValue).toLowerCase();
      const matches = rows.filter((row) => String(row[args.matchField] ?? '').toLowerCase() === value);
      if (!matches.length) return null;
      apply = () => matches.forEach((row) => Object.assign(row, updates));
    } else if (toolName === 'delete_records') {
      if (!Array.isArray(this.db.collections[collection]) || !Array.isArray(args.ids) || !args.ids.length || args.ids.length > 50) return null;
      const ids = new Set(args.ids.map(String));
      const remaining = rows.filter((row) => !ids.has(String(row.id)));
      if (remaining.length === rows.length) return null;
      apply = () => { this.db.collections[collection] = remaining; };
    }

    if (!apply) return null;
    const snapshot = this.createSnapshot();
    try {
      apply();
    } catch {
      this.db = snapshot;
      return null;
    }
    this.undoStack.push({ proposalId: proposal.id, summaryText: proposal.summaryText, snapshot });
    if (this.undoStack.length > 20) this.undoStack.shift();
    proposal.status = 'approved';
    if (this.onCommit) this.onCommit(this.db);
    return proposal;
  }

  rejectProposal(proposalId) {
    const proposal = this.pendingProposals.find((item) => item.id === proposalId && item.status === 'pending');
    if (!proposal) return null;
    proposal.status = 'rejected';
    return proposal;
  }

  undoLastCommit() {
    if (!this.undoStack.length) return null;
    const last = this.undoStack.pop();
    this.db = last.snapshot;
    if (this.onCommit) this.onCommit(this.db);
    return last;
  }
}
