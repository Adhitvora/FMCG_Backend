const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const dataService = require('../src/services/invoiceData.service');

const ids = Array.from({ length: 10 }, (_, index) => String(index + 1).padStart(24, '0'));
const replacement = (index, quantity, cartonId = null) => ({
  _id: ids[index], replacementId: `RL-${index}`, company: ids[8],
  party: { _id: ids[index], name: `Party ${index}`, town: 'Town', status: 'active' },
  town: 'Town', receivingLRNo: `RL-${index}`, receivingCases: quantity,
  cartonId, masterCartonId: cartonId, cartonStatus: cartonId ? 'MERGED' : 'AVAILABLE',
  cartonMergedAt: null, status: 'active', isDispatchLocked: false,
});
const query = (value) => ({
  populate() { return this; }, session() { return this; },
  lean: async () => value,
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
});

const harness = ({ rows, cartons = [], failRender = false, failClaim = false, loseClaimAcknowledgement = false } = {}) => {
  const state = { rows, saved: null, renderCount: 0, mergeCount: 0, claims: [], releases: [], removedFiles: [], renameCount: 0 };
  class FakeInvoice {
    constructor(values) { Object.assign(this, values); this._id = new mongoose.Types.ObjectId(); }
    toObject() { return { ...this }; }
    async save() {
      const data = dataService.buildInvoiceData(this);
      this.totalActualCases = data.totalCase1;
      this.totalCase2 = data.totalCase2;
      state.saved = this;
      return this;
    }
    static findById() { return query(state.saved); }
    static async deleteOne() { state.saved = null; }
  }
  const createMergedCarton = async ({ replacements }) => {
    assert.ok(state.renderCount > 0, 'Layout must be validated before saving a permanent merge');
    state.mergeCount++;
    const carton = { _id: ids[7], company: ids[8], cartonNumber: 'MC00001', physicalCaseCount: 1,
      entries: replacements.map((row) => ({ replacementId: row._id, cases: row.receivingCases })) };
    for (const row of replacements) Object.assign(row, { cartonId: carton._id, masterCartonId: carton._id, cartonStatus: 'MERGED', cartonMergedAt: new Date(), cartonGroupNumber: 1 });
    return carton;
  };
  const Replacement = {
    find: () => query(rows),
    async updateOne(filter, update) {
      if (filter.invoiceId) {
        state.releases.push(filter);
        const row = rows.find((candidate) => candidate._id === filter._id && candidate.invoiceId === filter.invoiceId);
        if (row) Object.assign(row, update.$set);
        return { modifiedCount: row ? 1 : 0 };
      }
      state.claims.push(filter);
      if (failClaim) return { modifiedCount: 0 };
      const row = rows.find((candidate) => candidate._id === filter._id);
      Object.assign(row, update.$set);
      if (loseClaimAcknowledgement) throw new Error('Network acknowledgement lost');
      return { modifiedCount: 1 };
    },
  };
  const MasterCarton = { find: () => query(cartons), updateMany: async () => ({ modifiedCount: cartons.length }) };
  const mockDependencies = {
    fs: { promises: { rename: async () => { state.renameCount++; } } },
    mongoose,
    '../models/invoice.model': FakeInvoice,
    '../models/replacement.model': Replacement,
    '../models/company.model': { findById: () => query({ _id: ids[8], name: 'Company', status: 'active' }) },
    '../models/transport.model': {},
    '../models/masterCarton.model': MasterCarton,
    '../models/counter.model': { getNextSequence: async () => 1 },
    '../utils/apiError': require('../src/utils/apiError'),
    '../utils/apiResponse': { created: (res, value) => { res.value = value; }, success: (res, value) => { res.value = value; } },
    '../middlewares/audit.middleware': { createAuditLog: async () => {}, getClientInfo: () => ({}) },
    '../configs/app.config': { pagination: {} },
    '../services/invoiceData.service': { ...dataService, hydrateInvoiceCartons: (invoice) => dataService.hydrateInvoiceCartons(invoice, { MasterCarton }) },
    '../services/cartonMerge.service': { createMergedCarton },
    '../utils/companyAccess': { applyCompanyScope() {}, assertCompanyAccess() {} },
    '../configs/db.config': { isReplicaSet: () => false },
    '../services/invoicePdf.service': {
      createTempPdfPath: () => '/temp/invoice.pdf', ensureInvoiceDirectories: async () => {},
      fileExists: async () => true,
      getInvoicePdfInfo: () => ({ absolutePath: '/invoices/test.pdf', publicPath: '/uploads/test.pdf', fileName: 'test.pdf' }),
      removeFileIfExists: async (file) => { if (file) state.removedFiles.push(file); },
      renderInvoicePdf: async (invoice) => {
        state.renderCount++;
        state.rendered = dataService.buildInvoiceData(invoice);
        if (failRender) throw new Error('Merged group is too tall for one A4 page');
      },
      renderInvoiceHtml: async () => '<html></html>',
      uploadInvoicePdfToCloudinary: async () => null,
    },
  };
  const filename = path.join(__dirname, '../src/controllers/invoice.controller.js');
  const context = {
    module: { exports: {} },
    require(name) {
      if (!(name in mockDependencies)) throw new Error(`Unexpected controller dependency ${name}`);
      return mockDependencies[name];
    },
    console,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const controller = context.module.exports;
  return {
    state, controller,
    async create(user = { id: ids[9], role: 'super_admin', username: 'test' }) {
      const res = {};
      let error;
      await controller.createInvoice({ user, body: { company: ids[8], replacementIds: rows.map((row) => row._id) } }, res, (caught) => { error = caught; });
      return { invoice: res.value, error };
    },
  };
};

test('invoice creation preserves received quantities and persists individual physical totals', async () => {
  const { state, create } = harness({ rows: [replacement(0, 2), replacement(1, 5)] });
  const { invoice, error } = await create();
  assert.equal(error, undefined);
  assert.equal(invoice.totalActualCases, 7);
  assert.equal(invoice.totalCase2, 7);
  assert.equal(invoice.pdfVersion, dataService.INVOICE_PDF_VERSION);
  assert.equal(invoice.cartons.length, 0);
  assert.equal(state.mergeCount, 0);
  assert.equal(state.claims[0].receivingCases, 2);
  assert.equal(state.claims[0].town, 'Town');
  assert.equal(state.claims[0].receivingLRNo, 'RL-0');
  assert.equal(state.claims[0].party, ids[0]);
});

test('invoice creation never creates an unsaved carton relationship', async () => {
  const { state, create } = harness({ rows: [replacement(0, 2), replacement(1, 5), replacement(2, 1)] });
  const { invoice, error } = await create();
  assert.equal(error, undefined);
  assert.equal(state.rendered.totalCase1, 8);
  assert.equal(state.rendered.totalCase2, 8);
  assert.equal(state.mergeCount, 0);
  assert.equal(invoice.totalCase2, 8);
  assert.ok(invoice.items.every((row) => row.cartonId == null));
  assert.equal(invoice.cartons.length, 0);
});

test('failed invoice PDF validation never creates merge or invoice claims', async () => {
  const { state, create } = harness({ rows: [replacement(0, 2), replacement(1, 5)], failRender: true });
  const { error } = await create();
  assert.match(error.message, /too tall/);
  assert.equal(state.mergeCount, 0);
  assert.equal(state.claims.length, 0);
  assert.equal(state.saved, null);
});

test('a single selected row remains an individual physical carton', async () => {
  const { state, create } = harness({ rows: [replacement(0, 5)] });
  const { invoice, error } = await create();
  assert.equal(error, undefined);
  assert.equal(invoice.totalCase2, 5);
  assert.equal(state.mergeCount, 0);
});

test('legacy one-member assigned carton remains individual when creating another invoice', async () => {
  const { create } = harness({ rows: [replacement(0, 5, ids[7])], cartons: [{ _id: ids[7], company: ids[8], entries: [{ replacementId: ids[0], cases: 5 }] }] });
  const { invoice, error } = await create();
  assert.equal(error, undefined);
  assert.equal(invoice.totalCase2, 5);
});

test('an individual replacement and a complete merged carton can share one invoice', async () => {
  const { create } = harness({
    rows: [replacement(0, 2), replacement(1, 3, ids[7]), replacement(2, 4, ids[7])],
    cartons: [{
      _id: ids[7], company: ids[8], physicalCaseCount: 1,
      entries: [{ replacementId: ids[1], cases: 3 }, { replacementId: ids[2], cases: 4 }],
    }],
  });
  const { invoice, error } = await create();
  assert.equal(error, undefined);
  assert.equal(invoice.items.length, 3);
  assert.equal(invoice.totalActualCases, 9);
  assert.equal(invoice.totalCase2, 3);
});

test('individual replacements and multiple complete merged cartons create one invoice', async () => {
  const { create } = harness({
    rows: [
      replacement(0, 2), replacement(1, 1, ids[7]), replacement(2, 1, ids[7]),
      replacement(3, 2, ids[6]), replacement(4, 4, ids[6]), replacement(5, 3),
    ],
    cartons: [
      { _id: ids[7], company: ids[8], physicalCaseCount: 1, entries: [{ replacementId: ids[1], cases: 1 }, { replacementId: ids[2], cases: 1 }] },
      { _id: ids[6], company: ids[8], physicalCaseCount: 1, entries: [{ replacementId: ids[3], cases: 2 }, { replacementId: ids[4], cases: 4 }] },
    ],
  });
  const { invoice, error } = await create();
  assert.equal(error, undefined);
  assert.equal(invoice.items.length, 6);
  assert.equal(invoice.cartons.length, 2);
  assert.equal(invoice.totalActualCases, 13);
  assert.equal(invoice.totalCase2, 7);
});

test('incomplete saved merge is rejected before rendering or updating any rows', async () => {
  const { state, create } = harness({ rows: [replacement(0, 2, ids[7])], cartons: [{ _id: ids[7], company: ids[8], entries: [{ replacementId: ids[0], cases: 2 }, { replacementId: ids[1], cases: 5 }] }] });
  const { error } = await create();
  assert.match(error.message, /Complete the selected merged carton/);
  assert.equal(state.renderCount, 0);
  assert.equal(state.claims.length, 0);
});

test('concurrent record changes prevent invoice creation', async () => {
  const { state, create } = harness({ rows: [replacement(0, 2)], failClaim: true });
  const { error } = await create();
  assert.match(error.message, /changed while/);
  assert.equal(state.saved, null);
  assert.equal(state.releases.length, 1);
});

test('lost claim acknowledgement releases only this invoice ownership', async () => {
  const row = replacement(0, 2);
  const { state, create } = harness({ rows: [row], loseClaimAcknowledgement: true });
  const { error } = await create();
  assert.match(error.message, /acknowledgement lost/);
  assert.equal(row.invoiceId, null);
  assert.equal(row.cartonStatus, 'AVAILABLE');
  assert.equal(state.releases.length, 1);
});

test('backend creation rejects unauthorized users and invalid case quantities', async () => {
  const unauthorized = harness({ rows: [replacement(0, 2)] });
  assert.equal((await unauthorized.create({ id: ids[9], role: 'viewer' })).error.statusCode, 403);
  const invalid = harness({ rows: [replacement(0, 0)] });
  assert.match((await invalid.create()).error.message, /positive whole number/);
  assert.equal(invalid.state.renderCount, 0);
});

test('old cached PDFs regenerate using source relationships and failed rendering preserves the previous PDF', async () => {
  const { state, controller } = harness({ rows: [], failRender: true });
  state.saved = {
    _id: ids[5], company: ids[8], invoiceNumber: 'OLD', pdfPath: '/uploads/old.pdf', pdfVersion: 0,
    items: [replacement(0, 2)].map((row) => ({ replacement: row._id, receivingCases: row.receivingCases })),
    cartons: [], toObject() { return { ...this }; },
  };
  let error;
  await controller.getInvoicePDF({ params: { id: ids[5] }, user: { role: 'super_admin' } }, {}, (caught) => { error = caught; });
  assert.match(error.message, /too tall/);
  assert.equal(state.renderCount, 1);
  assert.ok(!state.removedFiles.includes('/invoices/test.pdf'));
  assert.equal(state.renameCount, 0);
});
