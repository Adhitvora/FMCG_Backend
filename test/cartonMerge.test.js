const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCartonMergeService,
  validateMergeSelection,
} = require('../src/services/cartonMerge.service');
const MasterCarton = require('../src/models/masterCarton.model');
const Replacement = require('../src/models/replacement.model');
const { removeEntry } = require('../src/controllers/masterCarton.controller');

const objectId = (n) => n.toString(16).padStart(24, '0');
const company = objectId(100);
const user = { id: objectId(200), role: 'operator', companies: [company] };
const keyOf = (value) => String(value?._id || value || '');
const query = (value) => ({
  populate() { return this; },
  session() { return this; },
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
});

// An atomic in-memory collection double lets two service calls race against the
// same stored rows. Assertions check persisted membership and compensation.
const fixture = ({ rowOverrides = {}, saveError = false, lostAcknowledgement = false, onClaim } = {}) => {
  const rows = new Map([1, 2, 3, 4].map((n) => [objectId(n), {
    _id: objectId(n), replacementId: `REP-${n}`, company,
    party: { _id: objectId(300 + n), name: `Party ${n}`, status: 'active' },
    receivingCases: [2, 5, 1, 1][n - 1], status: 'active',
    cartonId: null, masterCartonId: null, cartonMergedAt: null, cartonMergedBy: null,
    cartonStatus: 'AVAILABLE', invoiceId: null,
    ...(rowOverrides[n] || {}),
  }]));
  const groups = new Map();
  let sequence = 0;
  let claims = 0;
  const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((alternative) => matches(row, alternative));
    if (expected?.$in) return expected.$in.some((id) => keyOf(id) === keyOf(row[key]));
    if (expected === null) return row[key] == null;
    return typeof expected === 'number' ? row[key] === expected : keyOf(row[key]) === keyOf(expected);
  });
  class CartonModel {
    constructor(data) { Object.assign(this, data, { _id: objectId(1000 + ++sequence) }); }
    async validate() {}
    async save() {
      if (saveError) throw new Error('Storage write failed');
      this.totalCases = this.entries.reduce((sum, entry) => sum + entry.cases, 0);
      this.createdAt = new Date();
      groups.set(keyOf(this._id), this);
      if (lostAcknowledgement) throw new Error('Save acknowledgement lost');
    }
    static findOne(filter) {
      const ids = filter['entries.replacementId'].$in;
      return query([...groups.values()].find((group) => group.entries.some((entry) => ids.includes(keyOf(entry.replacementId)))) || null);
    }
    static findById(id) { return query(groups.get(keyOf(id)) || null); }
  }
  const ReplacementModel = {
    find(filter) { return query(structuredClone([...rows.values()].filter((row) => matches(row, filter)))); },
    async updateOne(filter, update) {
      claims++;
      if (onClaim) await onClaim({ claims, rows, filter });
      const row = rows.get(keyOf(filter._id));
      if (!row || !matches(row, filter)) return { modifiedCount: 0 };
      Object.assign(row, update.$set);
      return { modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const row of rows.values()) {
        if (matches(row, filter)) { Object.assign(row, update.$set); modifiedCount++; }
      }
      return { modifiedCount };
    },
  };
  const service = createCartonMergeService({
    MasterCarton: CartonModel,
    Replacement: ReplacementModel,
    Company: { findById: () => query({ _id: company, status: 'active' }) },
    Counter: { getNextSequence: async () => ++sequence },
  });
  const merge = (ids, overrides = {}) => service.createMergedCarton({
    company, user, replacements: ids.map((n) => ({ _id: objectId(n) })), ...overrides,
  });
  return { rows, groups, merge, claims: () => claims };
};

test('selection requires at least two distinct valid rows', () => {
  for (const entries of [undefined, [], [{ replacementId: objectId(1) }], [{ replacementId: 'bad' }, { replacementId: objectId(2) }], [{ replacementId: objectId(1) }, { replacementId: objectId(1) }]]) {
    assert.throws(() => validateMergeSelection(entries), { statusCode: 400 });
  }
});

test('merge stores actual received quantities, all members, author and one physical carton', async () => {
  const f = fixture();
  const carton = await f.merge([1, 2, 3]);
  assert.deepEqual(carton.entries.map((entry) => entry.cases), [2, 5, 1]);
  assert.deepEqual(carton.entries.map((entry) => entry.partyName), ['Party 1', 'Party 2', 'Party 3']);
  assert.equal(carton.totalCases, 8);
  assert.equal(carton.physicalCaseCount, 1);
  assert.equal(carton.createdBy, user.id);
  assert.ok(carton.createdAt instanceof Date);
  for (const n of [1, 2, 3]) {
    assert.equal(f.rows.get(objectId(n)).cartonId, carton._id);
    assert.equal(f.rows.get(objectId(n)).cartonStatus, 'MERGED');
    assert.ok(f.rows.get(objectId(n)).cartonMergedAt instanceof Date);
  }
});

test('every original member remains unavailable for every subsequent merge', async () => {
  const f = fixture();
  await f.merge([1, 2]);
  for (const ids of [[1, 3], [2, 3], [1, 2]]) {
    await assert.rejects(f.merge(ids), { statusCode: 409, message: /already merged/ });
  }
  assert.equal(f.groups.size, 1);
  assert.equal(f.rows.get(objectId(3)).cartonId, null);
});

test('stored group membership protects a legacy row even when reverse links are missing', async () => {
  const f = fixture();
  f.groups.set('historic', { entries: [{ replacementId: objectId(1) }] });
  await assert.rejects(f.merge([1, 2]), { statusCode: 409, message: /already merged/ });
  assert.equal(f.claims(), 0);
});

test('permission and company boundaries are enforced before writes', async () => {
  const f = fixture();
  await assert.rejects(f.merge([1, 2], { user: null }), { statusCode: 401 });
  await assert.rejects(f.merge([1, 2], { user: { ...user, role: 'viewer' } }), { statusCode: 403 });
  await assert.rejects(f.merge([1, 2], { user: { ...user, companies: [objectId(999)] } }), { statusCode: 403 });
  assert.equal(f.claims(), 0);
});

test('invalid contexts, parties, saved quantities and ineligible rows produce no merge', async () => {
  const variants = [
    { company: objectId(999) }, { invoiceId: objectId(555) }, { status: 'cancelled' },
    { cartonStatus: 'DISPATCHED' }, { cartonMergedAt: new Date() }, { cartonMergedBy: user.id },
    { receivingCases: 0 }, { receivingCases: -1 }, { receivingCases: 1.5 },
    { receivingCases: NaN }, { receivingCases: Infinity }, { receivingCases: '2' },
    { party: null }, { party: { _id: objectId(301), name: 'Inactive', status: 'inactive' } },
  ];
  for (const invalid of variants) {
    const f = fixture({ rowOverrides: { 2: invalid } });
    await assert.rejects(f.merge([1, 2]), (error) => [400, 409].includes(error.statusCode));
    assert.equal(f.groups.size, 0);
    assert.equal(f.claims(), 0);
    assert.equal(f.rows.get(objectId(1)).cartonId, null);
  }
});

test('concurrent overlapping requests persist exactly one complete group', async () => {
  for (const [left, right] of [[[1, 2], [1, 3]], [[1, 3], [2, 3]], [[1, 2], [2, 1]]]) {
    const f = fixture();
    const result = await Promise.allSettled([f.merge(left), f.merge(right)]);
    assert.equal(result.filter((value) => value.status === 'fulfilled').length, 1);
    assert.equal(result.find((value) => value.status === 'rejected').reason.statusCode, 409);
    assert.equal(f.groups.size, 1);
    const carton = [...f.groups.values()][0];
    for (const row of f.rows.values()) {
      const member = carton.entries.some((entry) => entry.replacementId === row._id);
      assert.equal(row.cartonId, member ? carton._id : null);
      assert.equal(row.cartonStatus, member ? 'MERGED' : 'AVAILABLE');
    }
  }
});

test('a concurrent quantity edit makes a claim fail and rolls back earlier claims', async () => {
  const f = fixture({ onClaim: ({ claims, rows }) => { if (claims === 2) rows.get(objectId(2)).receivingCases = 7; } });
  await assert.rejects(f.merge([1, 2]), { statusCode: 409 });
  assert.equal(f.groups.size, 0);
  assert.equal(f.rows.get(objectId(1)).cartonId, null);
  assert.equal(f.rows.get(objectId(1)).cartonMergedAt, null);
  assert.equal(f.rows.get(objectId(2)).receivingCases, 7);
});

test('a stale invoice snapshot cannot create a permanent merge', async () => {
  const f = fixture();
  for (const stale of [{ receivingCases: 99 }, { party: objectId(999) }, { town: 'Changed town' }, { receivingLRNo: 'Changed LR' }, { isDispatchLocked: true }]) {
    await assert.rejects(f.merge([1, 2], { replacements: [{ _id: objectId(1), ...stale }, { _id: objectId(2) }] }), { statusCode: 409, message: /changed while preparing/ });
    assert.equal(f.groups.size, 0);
    assert.equal(f.claims(), 0);
  }
});

test('a town edit after snapshot validation fails its atomic claim', async () => {
  const f = fixture({ rowOverrides: { 2: { town: 'Original town' } }, onClaim: ({ claims, rows }) => { if (claims === 2) rows.get(objectId(2)).town = 'Changed town'; } });
  await assert.rejects(f.merge([1, 2], { replacements: [{ _id: objectId(1) }, { _id: objectId(2), town: 'Original town' }] }), { statusCode: 409 });
  assert.equal(f.groups.size, 0);
  assert.equal(f.rows.get(objectId(1)).cartonId, null);
});

test('a concurrent invoice claim is preserved while failed merge claims are released', async () => {
  const invoiceId = objectId(888);
  const f = fixture({ onClaim: ({ claims, rows }) => { if (claims === 2) rows.get(objectId(2)).invoiceId = invoiceId; } });
  await assert.rejects(f.merge([1, 2]), { statusCode: 409 });
  assert.equal(f.groups.size, 0);
  assert.equal(f.rows.get(objectId(1)).cartonId, null);
  assert.equal(f.rows.get(objectId(2)).invoiceId, invoiceId);
});

test('a failed carton write releases all claims and creates no orphan group', async () => {
  const f = fixture({ saveError: true });
  await assert.rejects(f.merge([1, 2]), /Storage write failed/);
  assert.equal(f.groups.size, 0);
  for (const row of f.rows.values()) {
    assert.equal(row.cartonId, null);
    assert.equal(row.cartonMergedAt, null);
  }
});

test('a lost save acknowledgement preserves the successfully stored group', async () => {
  const f = fixture({ lostAcknowledgement: true });
  const carton = await f.merge([1, 2]);
  assert.equal(f.groups.size, 1);
  assert.equal(f.rows.get(objectId(1)).cartonId, carton._id);
  assert.equal(f.rows.get(objectId(2)).cartonId, carton._id);
});

test('master carton physical count defaults to one and rejects invalid counts', () => {
  const valid = { cartonNumber: 'MC00001', company, createdBy: user.id };
  assert.equal(new MasterCarton(valid).physicalCaseCount, 1);
  for (const physicalCaseCount of [0, -1, 1.5, Infinity]) {
    assert.ok(new MasterCarton({ ...valid, physicalCaseCount }).validateSync()?.errors.physicalCaseCount);
  }
});

test('saving an unrelated edit preserves permanent merge history with a missing legacy link', async () => {
  const mergedAt = new Date('2026-01-01');
  const row = new Replacement({ replacementId: 'REP-HISTORY', company, party: objectId(301), createdBy: user.id,
    receivingDate: new Date(), cartonMergedAt: mergedAt, cartonMergedBy: user.id });
  await row.validate();
  assert.equal(row.cartonStatus, 'MERGED');
  assert.equal(row.cartonMergedAt.getTime(), mergedAt.getTime());
  assert.equal(keyOf(row.cartonMergedBy), user.id);
});

test('the former unmerge endpoint cannot remove members even for super admin', async () => {
  const original = MasterCarton.findById;
  MasterCarton.findById = async () => ({ company, status: 'Open', entries: [{ replacementId: objectId(1) }] });
  try {
    let failure;
    await removeEntry({ params: { id: objectId(500) }, user: { ...user, role: 'super_admin' }, body: { replacementId: objectId(1) } }, {}, (error) => { failure = error; });
    assert.equal(failure.statusCode, 409);
    assert.match(failure.message, /permanent/);
  } finally { MasterCarton.findById = original; }
});
