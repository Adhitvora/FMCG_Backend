const ApiError = require('../utils/apiError');

// Increment whenever saved PDFs must be regenerated with a changed template/domain.
const INVOICE_PDF_VERSION = 2;
const idOf = (value) => value == null ? '' : String(value._id || value);

const caseQuantity = (value, label) => {
  if (value === '' || value == null || typeof value === 'boolean') {
    throw ApiError.badRequest(`${label} must be a positive whole number`);
  }
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw ApiError.badRequest(`${label} must be a positive whole number`);
  }
  return quantity;
};

const getCase1 = (item) => caseQuantity(
  item.receivingCases ?? item.actualCases,
  `Received cases for ${item.replacementId || item.partyName || 'invoice row'}`,
);

const snapshotCarton = (carton) => ({
  masterCartonId: carton._id,
  memberReplacementIds: (carton.entries || []).map((entry) => entry.replacementId?._id || entry.replacementId),
  // A persisted carton merge is one physical carton. This fallback supports
  // historical records that predate the explicit field; it never derives a
  // relationship from party/product/invoice display data.
  physicalCaseCount: caseQuantity(carton.physicalCaseCount ?? 1, 'Physical carton count'),
  totalCases: (carton.entries || []).reduce((sum, entry) => sum + Number(entry.cases || 0), 0),
  label: carton.cartonNumber || '',
});

/** Normalize saved data once; both the PDF rows and totals consume this result. */
const buildInvoiceData = (invoice) => {
  const cartons = new Map();
  for (const carton of invoice.cartons || []) {
    const key = idOf(carton.masterCartonId);
    if (!key) continue;
    if (cartons.has(key)) throw ApiError.conflict('Invoice contains a duplicate carton relationship');
    cartons.set(key, carton);
  }

  const groupsByKey = new Map();
  const seenReplacements = new Set();
  for (const [index, item] of (invoice.items || []).entries()) {
    const replacementId = idOf(item.replacement);
    if (replacementId && seenReplacements.has(replacementId)) {
      throw ApiError.conflict('Invoice contains the same replacement more than once');
    }
    if (replacementId) seenReplacements.add(replacementId);
    const cartonId = idOf(item.cartonId || item.masterCartonId || item.mergeGroupId);
    const key = cartonId ? `carton:${cartonId}` : `replacement:${replacementId || index}`;
    if (!groupsByKey.has(key)) groupsByKey.set(key, { key, cartonId, firstIndex: index, rowIndexes: [], rows: [] });
    const group = groupsByKey.get(key);
    group.rowIndexes.push(index);
    group.rows.push({ item, case1: getCase1(item), replacementId });
  }

  let totalCase1 = 0;
  let totalCase2 = 0;
  const groups = [...groupsByKey.values()].map((group) => {
    const snapshot = cartons.get(group.cartonId);
    const memberIds = (snapshot?.memberReplacementIds || []).map(idOf);
    if (memberIds.length) {
      const expected = new Set(memberIds);
      const actual = new Set(group.rows.map((row) => row.replacementId));
      if (expected.size !== memberIds.length || actual.size !== expected.size
        || [...actual].some((id) => !expected.has(id))) {
        throw ApiError.conflict('Complete the selected merged carton before invoicing. This invoice contains an incomplete carton group.');
      }
    }
    const isMerged = Boolean(group.cartonId && group.rows.length > 1);
    if (isMerged && group.rowIndexes.at(-1) - group.rowIndexes[0] + 1 !== group.rows.length) {
      throw ApiError.conflict('Merged carton rows must be consecutive in invoice order so they can print as one physical carton. Keep the saved group together when selecting invoice rows.');
    }
    if (isMerged && snapshot?.physicalCaseCount != null && caseQuantity(snapshot.physicalCaseCount, 'Physical carton count') !== 1) {
      throw ApiError.conflict('A carton merge must represent exactly one physical carton. Correct the saved carton relationship before invoicing.');
    }
    const physicalCaseCount = isMerged
      ? 1
      : group.rows[0].case1;
    totalCase1 += group.rows.reduce((sum, row) => sum + row.case1, 0);
    totalCase2 += physicalCaseCount;
    return {
      ...group,
      isMerged,
      physicalCaseCount,
      rows: group.rows.map((row, index) => ({
        ...row,
        mergeGroupId: isMerged ? group.cartonId : null,
        mergeCaseCount: isMerged ? physicalCaseCount : row.case1,
        case2: isMerged ? (index === 0 ? physicalCaseCount : null) : row.case1,
        renderCase2: !isMerged || index === 0,
        case2Rowspan: isMerged && index === 0 ? group.rows.length : 1,
      })),
    };
  }).sort((left, right) => left.firstIndex - right.firstIndex);
  if (!Number.isSafeInteger(totalCase1) || !Number.isSafeInteger(totalCase2)) {
    throw ApiError.badRequest('Invoice case totals exceed the supported quantity');
  }
  return { groups, totalCase1, totalCase2 };
};

const buildInvoiceRows = (invoice) => buildInvoiceData(invoice).groups.flatMap((group) => group.rows.map((row) => ({
  partyId: row.item.party || null,
  partyName: row.item.partyName || '',
  town: row.item.town || '',
  rlNo: row.item.lrNo || '',
  replacementId: row.replacementId,
  case1: row.case1,
  mergeGroupId: row.mergeGroupId,
  mergeCaseCount: row.mergeCaseCount,
  case2: row.mergeGroupId ? row.case2 : row.case1,
  renderCase2: row.renderCase2,
  case2Rowspan: row.case2Rowspan,
})));

const calculateCase2 = (invoice) => buildInvoiceData(invoice).totalCase2;

/** Upgrade legacy snapshots using existing database relationships, never names. */
const hydrateInvoiceCartons = async (invoice, { MasterCarton, session } = {}) => {
  const existing = new Map((invoice.cartons || []).map((carton) => [idOf(carton.masterCartonId), carton]));
  const neededIds = [...new Set((invoice.items || []).map((item) => idOf(item.cartonId)).filter(Boolean))]
    .filter((id) => !existing.get(id)?.memberReplacementIds?.length || existing.get(id)?.physicalCaseCount == null);
  if (neededIds.length) {
    const CartonModel = MasterCarton || require('../models/masterCarton.model');
    let query = CartonModel.find({ _id: { $in: neededIds }, company: invoice.company?._id || invoice.company });
    if (session) query = query.session(session);
    const cartons = await query.lean();
    const found = new Map(cartons.map((carton) => [idOf(carton._id), carton]));
    for (const id of neededIds) {
      if (!found.has(id)) throw ApiError.conflict('A saved carton relationship is missing. Restore its source record before generating this invoice.');
      existing.set(id, snapshotCarton(found.get(id)));
    }
    invoice.cartons = [...existing.values()].filter((carton) => idOf(carton.masterCartonId));
  }
  const data = buildInvoiceData(invoice);
  invoice.totalActualCases = data.totalCase1;
  invoice.totalCase2 = data.totalCase2;
  return invoice;
};

module.exports = {
  INVOICE_PDF_VERSION,
  buildInvoiceData,
  buildInvoiceRows,
  calculateCase2,
  caseQuantity,
  getCase1,
  hydrateInvoiceCartons,
  idOf,
  snapshotCarton,
};
