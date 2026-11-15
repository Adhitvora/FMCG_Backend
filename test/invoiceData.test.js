const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Invoice = require('../src/models/invoice.model');
const { buildInvoiceData, buildInvoiceRows, calculateCase2, hydrateInvoiceCartons, snapshotCarton } = require('../src/services/invoiceData.service');

const item = (id, quantity, cartonId = null) => ({
  replacement: id, replacementId: `RL-${id}`, partyName: `Party ${id}`,
  receivingCases: quantity, actualCases: quantity, cartonId,
});
const carton = (id, members, physicalCaseCount = 1) => ({ masterCartonId: id, memberReplacementIds: members, physicalCaseCount });

test('the requested mixed example totals 9 received and 4 physical cases', () => {
  const data = buildInvoiceData({
    items: [item('A', 2), item('B', 5, 'M1'), item('C', 1, 'M1'), item('D', 1)],
    cartons: [carton('M1', ['B', 'C'])],
    totalActualCases: 999, totalCase2: 999,
  });
  assert.equal(data.totalCase1, 9);
  assert.equal(data.totalCase2, 4);
  assert.deepEqual(data.groups.flatMap((group) => group.rows.map((row) => row.case2)), [2, 1, null, 1]);
  assert.equal(data.groups[1].rows.length, 2);
});

test('a combined invoice preserves the requested 9 Case 1 and 8 Case 2 totals', () => {
  const invoice = {
    items: [item('A', 2), item('B', 1, 'MG-001'), item('C', 1, 'MG-001'), item('D', 5)],
    cartons: [carton('MG-001', ['B', 'C'])],
  };
  const data = buildInvoiceData(invoice);
  assert.equal(data.totalCase1, 9);
  assert.equal(data.totalCase2, 8);
  assert.deepEqual(buildInvoiceRows(invoice).map((row) => [row.replacementId, row.case1, row.case2, row.case2Rowspan]), [
    ['A', 2, 2, 1], ['B', 1, 1, 2], ['C', 1, null, 1], ['D', 5, 5, 1],
  ]);
});

test('ten individual rows mirror CASE 1 exactly and never leave CASE 2 blank', () => {
  const quantities = [2, 5, 1, 1, 1, 1, 2, 1, 1, 1];
  const data = buildInvoiceData({ items: quantities.map((quantity, index) => item(String(index), quantity)) });
  assert.deepEqual(data.groups.map((group) => group.rows[0].case2), quantities);
  assert.deepEqual(buildInvoiceRows({ items: quantities.map((quantity, index) => item(String(index), quantity)) }).map((row) => ({
    case1: row.case1,
    case2: row.case2,
    mergeGroupId: row.mergeGroupId,
    renderCase2: row.renderCase2,
    case2Rowspan: row.case2Rowspan,
  })), quantities.map((quantity) => ({
    case1: quantity,
    case2: quantity,
    mergeGroupId: null,
    renderCase2: true,
    case2Rowspan: 1,
  })));
  assert.equal(data.totalCase1, 16);
  assert.equal(calculateCase2({ items: quantities.map((quantity, index) => item(String(index), quantity)) }), 16);
  assert.ok(data.groups.every((group) => !group.isMerged));
});

test('all three rows merge into one physical carton counted once', () => {
  const invoice = { items: [item('A', 2, 'M'), item('B', 5, 'M'), item('C', 1, 'M')], cartons: [carton('M', ['A', 'B', 'C'])] };
  const data = buildInvoiceData(invoice);
  assert.equal(data.groups.length, 1);
  assert.equal(data.totalCase1, 8);
  assert.equal(calculateCase2(invoice), 1);
  assert.deepEqual(buildInvoiceRows(invoice).map((row) => ({
    case1: row.case1,
    case2: row.case2,
    mergeGroupId: row.mergeGroupId,
    renderCase2: row.renderCase2,
    case2Rowspan: row.case2Rowspan,
  })), [
    { case1: 2, case2: 1, mergeGroupId: 'M', renderCase2: true, case2Rowspan: 3 },
    { case1: 5, case2: null, mergeGroupId: 'M', renderCase2: false, case2Rowspan: 1 },
    { case1: 1, case2: null, mergeGroupId: 'M', renderCase2: false, case2Rowspan: 1 },
  ]);
});

test('empty, null and missing merge ids are individual physical cartons', () => {
  const rows = buildInvoiceRows({ items: [
    { ...item('A', 2), cartonId: '' },
    { ...item('B', 5), cartonId: null },
    { ...item('C', 1), cartonId: undefined, mergeGroupId: '' },
  ] });
  assert.deepEqual(rows.map((row) => [row.case1, row.case2, row.mergeGroupId, row.case2Rowspan]), [
    [2, 2, null, 1],
    [5, 5, null, 1],
    [1, 1, null, 1],
  ]);
  assert.equal(calculateCase2({ items: [
    { ...item('A', 2), cartonId: '' },
    { ...item('B', 5), cartonId: null },
    { ...item('C', 1), cartonId: undefined, mergeGroupId: '' },
  ] }), 8);
});

test('the required Test C fixture counts two persisted merge groups and individuals', () => {
  const invoice = {
    items: [
      item('A', 2),
      item('B', 5, 'M1'),
      item('C', 1, 'M1'),
      item('D', 4, 'M2'),
      item('E', 2, 'M2'),
      item('F', 3),
    ],
    cartons: [carton('M1', ['B', 'C']), carton('M2', ['D', 'E'])],
  };
  const rows = buildInvoiceRows(invoice);
  assert.equal(buildInvoiceData(invoice).totalCase1, 17);
  assert.equal(calculateCase2(invoice), 7);
  assert.deepEqual(rows.map((row) => [row.replacementId, row.case1, row.case2, row.mergeGroupId, row.case2Rowspan]), [
    ['A', 2, 2, null, 1],
    ['B', 5, 1, 'M1', 2],
    ['C', 1, null, 'M1', 1],
    ['D', 4, 1, 'M2', 2],
    ['E', 2, null, 'M2', 1],
    ['F', 3, 3, null, 1],
  ]);
});

test('interleaved merge members are rejected rather than moving parties out of invoice order', () => {
  const invoice = {
    items: [item('A', 2, 'M1'), item('B', 1, 'M2'), item('C', 5), item('D', 4, 'M1'), item('E', 1, 'M2')],
    cartons: [carton('M1', ['A', 'D']), carton('M2', ['B', 'E'])],
  };
  assert.throws(() => buildInvoiceData(invoice), /must be consecutive in invoice order/);
});

test('critical 16-carton case: a persisted group of four contributes one physical carton', () => {
  const invoice = {
    items: Array.from({ length: 16 }, (_, index) => item(String(index + 1), 1, index < 4 ? 'M1' : null)),
    cartons: [carton('M1', ['1', '2', '3', '4'])],
  };
  const data = buildInvoiceData(invoice);
  assert.equal(data.totalCase1, 16);
  assert.equal(data.totalCase2, 13);
  assert.deepEqual(data.groups[0].rows.map((row) => [row.case1, row.case2, row.case2Rowspan]), [
    [1, 1, 4], [1, null, 1], [1, null, 1], [1, null, 1],
  ]);
});

test('mixed rows retain their order: only the saved three-row group receives a Case 2 rowspan', () => {
  const invoice = {
    items: [item('A', 2), item('B', 1), item('C', 1, 'M1'), item('D', 1, 'M1'), item('E', 1, 'M1'), item('F', 5)],
    cartons: [carton('M1', ['C', 'D', 'E'])],
  };
  const rows = buildInvoiceRows(invoice);
  assert.equal(buildInvoiceData(invoice).totalCase1, 11);
  assert.equal(calculateCase2(invoice), 9);
  assert.deepEqual(rows.map((row) => [row.replacementId, row.case1, row.case2, row.case2Rowspan]), [
    ['A', 2, 2, 1], ['B', 1, 1, 1], ['C', 1, 1, 3],
    ['D', 1, null, 1], ['E', 1, null, 1], ['F', 5, 5, 1],
  ]);
});

test('multiple saved merge groups calculate physical cartons independently', () => {
  const invoice = {
    items: Array.from({ length: 20 }, (_, index) => item(String(index + 1), 1,
      index < 4 ? 'M1' : index < 7 ? 'M2' : null)),
    cartons: [carton('M1', ['1', '2', '3', '4']), carton('M2', ['5', '6', '7'])],
  };
  assert.equal(buildInvoiceData(invoice).totalCase1, 20);
  assert.equal(calculateCase2(invoice), 15);
});

test('a legacy singleton carton is individual even with stale merge flags and display labels', () => {
  const data = buildInvoiceData({
    items: [{ ...item('A', 5, 'M1'), isMergedGroup: true, case2Value: null, cartonDisplayValue: 99, cartonLabel: 'C1-1' },
      { ...item('B', 2), cartonLabel: 'C1-1', masterCartonNumber: 'M1' }],
    cartons: [carton('M1', ['A'])],
  });
  assert.equal(data.groups[0].isMerged, false);
  assert.equal(data.groups[0].physicalCaseCount, 5);
  assert.equal(data.totalCase2, 7);
});

test('received cases are authoritative over stale actual/dispatch quantities', () => {
  const data = buildInvoiceData({ items: [{ ...item('A', 5), actualCases: 0, dispatchCases: 200 }] });
  assert.equal(data.totalCase1, 5);
  assert.equal(data.totalCase2, 5);
  assert.equal(buildInvoiceData({ items: [{ replacement: 'B', actualCases: 2 }] }).totalCase1, 2);
});

test('partial, duplicated and inconsistent saved memberships are rejected', () => {
  assert.throws(() => buildInvoiceData({ items: [item('A', 2, 'M')], cartons: [carton('M', ['A', 'B'])] }), /incomplete carton group/);
  assert.throws(() => buildInvoiceData({ items: [item('A', 2), item('A', 2)] }), /same replacement/);
  assert.throws(() => buildInvoiceData({ items: [item('A', 2, 'M'), item('B', 1, 'M')], cartons: [carton('M', ['A', 'A'])] }), /incomplete carton group/);
  assert.throws(() => buildInvoiceData({ items: [item('A', 2, 'M')], cartons: [carton('M', ['A']), carton('M', ['A'])] }), /duplicate carton/);
});

test('invalid case quantities and physical counts fail before PDF rendering', () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity, '', true, 'abc']) {
    assert.throws(() => buildInvoiceData({ items: [item('A', invalid)] }), /positive whole number/);
    assert.throws(() => buildInvoiceData({ items: [item('A', 2, 'M'), item('B', 1, 'M')], cartons: [carton('M', ['A', 'B'], invalid)] }), /positive whole number/);
  }
});

test('legacy hydration consults actual MasterCarton membership and defaults its historic physical count to one', async () => {
  let queryFilter;
  const invoice = { company: 'company', items: [item('A', 2, 'M'), item('B', 5, 'M')], cartons: [{ masterCartonId: 'M', label: 'C8' }] };
  await hydrateInvoiceCartons(invoice, { MasterCarton: { find(filter) {
    queryFilter = filter;
    return { lean: async () => [{ _id: 'M', entries: [{ replacementId: 'A', cases: 2 }, { replacementId: 'B', cases: 5 }] }] };
  } } });
  assert.equal(queryFilter.company, 'company');
  assert.deepEqual(invoice.cartons[0].memberReplacementIds, ['A', 'B']);
  assert.equal(invoice.totalCase2, 1);
  assert.equal(invoice.totalActualCases, 7);
});

test('legacy hydration refuses missing source records and partial historical invoices', async () => {
  const invoice = () => ({ company: 'company', items: [item('A', 2, 'M')], cartons: [] });
  await assert.rejects(() => hydrateInvoiceCartons(invoice(), { MasterCarton: { find: () => ({ lean: async () => [] }) } }), /relationship is missing/);
  await assert.rejects(() => hydrateInvoiceCartons(invoice(), { MasterCarton: { find: () => ({ lean: async () => [{ _id: 'M', entries: [{ replacementId: 'A', cases: 2 }, { replacementId: 'B', cases: 1 }] }] }) } }), /incomplete carton group/);
});

test('complete snapshots remain stable without querying mutable current records', async () => {
  const invoice = { items: [item('A', 2, 'M'), item('B', 1, 'M')], cartons: [carton('M', ['A', 'B'])] };
  await hydrateInvoiceCartons(invoice, { MasterCarton: { find: () => { throw new Error('Unexpected query'); } } });
  assert.equal(invoice.totalCase2, 1);
});

test('invoice schema persists physical totals and full relationship snapshots across reloads', async () => {
  const [company, createdBy, a, b, m] = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
  const invoice = new Invoice({
    company, createdBy, invoiceNumber: 'TEST-1', invoiceDate: new Date(),
    items: [item(a, 2, m), item(b, 5, m)],
    cartons: [{ ...carton(m, [a, b], 1), label: '1' }],
    totalCase2: 1, pdfVersion: 2,
  });
  await invoice.validate();
  const reloaded = new Invoice(invoice.toObject());
  assert.equal(reloaded.totalCase2, 1);
  assert.equal(reloaded.pdfVersion, 2);
  assert.equal(reloaded.cartons[0].physicalCaseCount, 1);
  assert.equal(reloaded.cartons[0].memberReplacementIds.length, 2);
  assert.equal(buildInvoiceData(reloaded).totalCase2, 1);
  assert.equal(snapshotCarton({ _id: m, entries: [{ replacementId: a, cases: 2 }] }).physicalCaseCount, 1);
});
