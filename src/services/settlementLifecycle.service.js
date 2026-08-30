const Counter = require('../models/counter.model');
const Settlement = require('../models/settlement.model');

const generateSettlementNo = async (session = null) => {
  const year = new Date().getFullYear();
  const sequence = await Counter.getNextSequence('settlement_' + year, session);
  return `SET-${year}-${String(sequence).padStart(6, '0')}`;
};

const buildApprovedProductsFromReplacement = (replacement) => {
  if (replacement.approvalType === 'Product') {
    return (replacement.approvalProducts || []).map((product) => ({
      productId: product.productId || null,
      productName: product.productName || '',
      productNameSnapshot: product.productNameSnapshot || product.productName || '',
      sku: product.sku || '',
      productCode: product.productCode || '',
      mrp: Number(product.mrp || 0),
      mrpSnapshot: Number(product.mrpSnapshot || product.mrp || 0),
      masterMrpSnapshot: Number(product.masterMrpSnapshot || 0),
      quantity: Number(product.quantity || 0),
      unit: product.unit || 'pcs',
      value: Number(product.totalValue || product.value || (Number(product.mrp || 0) * Number(product.quantity || 0))),
      calculatedValue: Number(product.totalValue || product.value || (Number(product.mrp || 0) * Number(product.quantity || 0))),
    })).filter((product) => product.productName || product.value);
  }

  return [];
};

const getApprovedValueFromReplacement = (replacement) => {
  if (replacement.approvalType === 'Product') {
    const productValue = Number(replacement.totalProductApprovalValue || 0);
    return productValue || Number(replacement.approvalAmount || 0);
  }
  return Number(replacement.approvalAmount || 0);
};

const ensureSettlementForReplacement = async (replacement, userId, session = null) => {
  const existing = await Settlement.findOne({ replacementId: replacement._id }).session(session || null);
  if (existing) {
    existing.invoiceId = replacement.invoiceId || existing.invoiceId || null;
    existing.partyId = replacement.party;
    existing.companyId = replacement.company;
    existing.approvalType = replacement.approvalType || 'Amount';
    existing.approvedAmount = Number(replacement.approvalAmount || getApprovedValueFromReplacement(replacement) || 0);
    existing.approvedProducts = buildApprovedProductsFromReplacement(replacement);
    existing.companyRLNo = replacement.companyRLNo || replacement.companyReference || existing.companyRLNo || '';
    existing.cnNo = replacement.cnNo || existing.cnNo || '';
    await existing.save(session ? { session } : undefined);
    return existing;
  }

  const settlementNo = await generateSettlementNo(session);
  const settlement = new Settlement({
    settlementNo,
    replacementId: replacement._id,
    invoiceId: replacement.invoiceId || null,
    partyId: replacement.party,
    companyId: replacement.company,
    approvalId: replacement._id,
    approvalType: replacement.approvalType || 'Amount',
    approvedAmount: Number(replacement.approvalAmount || getApprovedValueFromReplacement(replacement) || 0),
    approvedProducts: buildApprovedProductsFromReplacement(replacement),
    companyRLNo: replacement.companyRLNo || replacement.companyReference || '',
    cnNo: replacement.cnNo || '',
    settlementStatus: 'PENDING',
    createdBy: userId,
  });
  await settlement.save(session ? { session } : undefined);
  return settlement;
};

module.exports = {
  buildApprovedProductsFromReplacement,
  ensureSettlementForReplacement,
  generateSettlementNo,
  getApprovedValueFromReplacement,
};
