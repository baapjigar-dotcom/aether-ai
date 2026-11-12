/** NovaOS AI unit tests: approval-gated DB transactions and local document retrieval. */
import assert from 'node:assert/strict';
import { SmartDbTransactionManager } from '../modules/db-tools.js';
import { RagEngine } from '../modules/rag-engine.js';

console.log('Running NovaOS AI Unit Test Suite...\n');

const seedDb = () => ({ activeCollection: 'CRM_Leads', collections: { CRM_Leads: [{ id: 'REC-1', company: 'Acme Corp', dealValue: '$10,000' }] } });
const dbManager = new SmartDbTransactionManager(seedDb());
const insert = dbManager.proposeToolCall('insert_records', { collection: 'CRM_Leads', records: [{ id: 'REC-2', company: 'Beta Inc', dealValue: '$25,000' }] }, 'Insert Beta Inc lead');
assert.equal(insert.status, 'pending');
assert.equal(dbManager.db.collections.CRM_Leads.length, 1, 'database must not mutate before approval');
assert.equal(dbManager.approveProposal(insert.id)?.status, 'approved');
assert.equal(dbManager.db.collections.CRM_Leads.length, 2);
dbManager.undoLastCommit();
assert.equal(dbManager.db.collections.CRM_Leads.length, 1);
console.log('✅ PASS: pending DB mutation, explicit approval and undo');

const beforeUnsafeDelete = JSON.stringify(dbManager.db);
const unsafeDelete = dbManager.proposeToolCall('delete_records', { collection: 'CRM_Leads', ids: [] }, 'Clear all records');
assert.equal(dbManager.approveProposal(unsafeDelete.id), null, 'empty-ID delete must not clear a collection');
assert.equal(JSON.stringify(dbManager.db), beforeUnsafeDelete);
const unsafeUpdate = dbManager.proposeToolCall('update_records', { collection: 'CRM_Leads', updates: { status: 'Closed' } }, 'Update all');
assert.equal(dbManager.approveProposal(unsafeUpdate.id), null, 'unscoped updates must be rejected');
const duplicateCollection = dbManager.proposeToolCall('create_collection', { collection: 'CRM_Leads', seedRecords: [] }, 'Replace existing collection');
assert.equal(dbManager.approveProposal(duplicateCollection.id), null, 'existing collections must not be overwritten');
assert.throws(() => dbManager.proposeToolCall('drop_database', {}, 'unknown'), /Unsupported database tool/);
console.log('✅ PASS: unsafe collection-wide delete, unscoped update and overwrite are blocked');

const rag = new RagEngine();
rag.ingestDocument('architecture.md', 'Microservices communicate over gRPC and Kafka event streams.\n\nPostgreSQL handles transactional ACID ledger entries.');
const hits = rag.searchRelevantChunks('How are ACID ledger entries stored?', 1);
assert.equal(hits.length, 1);
assert.match(hits[0].text, /PostgreSQL/);
console.log('✅ PASS: BM25 ranks the relevant database architecture passage');

const longText = 'First section: ' + 'alpha beta gamma delta epsilon. '.repeat(180) + '\n\nSecond section: PostgreSQL stores immutable payment ledger transactions.';
const longDocument = rag.ingestDocument('long-report.txt', longText);
assert.ok(longDocument.chunks.length > 3, 'long documents should be split into overlapping chunks');
assert.ok(longDocument.chunks.every((chunk) => chunk.text.length <= 1000), 'chunks should respect the size limit');
assert.ok(longDocument.chunks.some((chunk) => chunk.text.includes('PostgreSQL')), 'later document content must not be truncated');
const secondHits = rag.searchRelevantChunks('Where are payment ledger transactions stored?', 3);
assert.ok(secondHits.some((hit) => hit.text.includes('PostgreSQL')));
console.log('✅ PASS: long-document chunking preserves later content and retrieves it');

const reloaded = new RagEngine();
reloaded.loadDocuments(JSON.parse(JSON.stringify(rag.documents)));
assert.ok(reloaded.searchRelevantChunks('ACID ledger entries', 1).length);
console.log('✅ PASS: RAG documents can be rehydrated from persisted JSON');
console.log('\n🎉 All NovaOS AI tests passed!');
