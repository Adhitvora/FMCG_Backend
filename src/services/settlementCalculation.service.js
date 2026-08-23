const MAPPING_STATUSES = [
  'EXACT_MATCH',
  'SUBSTITUTED',
  'PARTIAL',
  'EXCESS',
  'SHORT',
  'NOT_GIVEN',
  'WRONG_PRODUCT',
  'PENDING_REVIEW',
  'MANUAL_APPROVAL',
];

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const toNumber = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
};

const cleanString = (value) => String(value || '').trim();

const productIdentity = (product = {}) => {
  if (product.productId) return `id:${String(product.productId)}`;
  return `name:${cleanString(product.productName || product.name).toLowerCase()}`;
};

const productNameKey = (product = {}) => cleanString(product.productName || product.name).toLowerCase();

const calculateProductValue = (product = {}) => {
  const mrp = toNumber(product.mrp);
  const quantity = toNumber(product.quantity);
  const calculated = roundMoney(mrp * quantity);
  const explicit = toNumber(product.value ?? product.calculatedValue ?? product.totalValue);
  return explicit > 0 ? roundMoney(explicit) : calculated;
};

const normalizeProductRow = (product = {}) => {
  const mrp = toNumber(product.mrp);
  const quantity = toNumber(product.quantity);
  const value = calculateProductValue({ ...product, mrp, quantity });

  return {
    productId: product.productId || null,
    productName: cleanString(product.productName || product.name),
    sku: cleanString(product.sku),
    productCode: cleanString(product.productCode || product.code),
    mrp,
    quantity,
    unit: cleanString(product.unit) || 'pcs',
    value,
    calculatedValue: value,
    batchNo: cleanString(product.batchNo),
    expiryDate: product.expiryDate || null,
    remarks: cleanString(product.remarks),
  };
};

const normalizeProductRows = (rows = []) => {
  if (typeof rows === 'string' && rows.trim()) rows = JSON.parse(rows);
  if (!Array.isArray(rows)) return [];

  return rows
    .map(normalizeProductRow)
    .filter((product) => product.productName || product.mrp || product.quantity || product.value);
};

const sumProducts = (products = []) => products.reduce((totals, product) => {
  totals.quantity += toNumber(product.quantity);
  totals.value = roundMoney(totals.value + toNumber(product.value || product.calculatedValue));
  return totals;
}, { quantity: 0, value: 0 });

const sentProductSnapshot = (product = {}) => ({
  sentProductId: product.productId || null,
  sentProductName: product.productName || '',
  sentMRP: toNumber(product.mrp),
  sentQuantity: toNumber(product.quantity),
  sentValue: roundMoney(product.value || product.calculatedValue),
});

const hasSameProductIdentity = (approved, sentItems) => {
  if (!sentItems.length) return false;
  const approvedIdentity = productIdentity(approved);
  const approvedName = productNameKey(approved);

  return sentItems.every((sent) => {
    if (approved.productId && sent.productId) return productIdentity(sent) === approvedIdentity;
    return productNameKey(sent) === approvedName;
  });
};

const statusForMapping = ({ approved, sentItems, quantityDifference, valueDifference }) => {
  if (!approved && sentItems.length) return 'WRONG_PRODUCT';
  if (approved && !sentItems.length) return 'NOT_GIVEN';
  if (!approved) return 'PENDING_REVIEW';

  const sameProduct = hasSameProductIdentity(approved, sentItems);
  const qtyMatches = quantityDifference === 0;
  const valueMatches = valueDifference === 0;

  if (sameProduct && qtyMatches && valueMatches) return 'EXACT_MATCH';
  if (!sameProduct && qtyMatches && valueMatches) return 'SUBSTITUTED';
  if (quantityDifference < 0 || valueDifference < 0) {
    if (quantityDifference > 0 || valueDifference > 0) return 'PARTIAL';
    return 'SHORT';
  }
  if (quantityDifference > 0 || valueDifference > 0) return 'EXCESS';
  return sameProduct ? 'EXACT_MATCH' : 'SUBSTITUTED';
};

const buildMapping = (approved, sentItems, remark = '') => {
  const sentTotals = sumProducts(sentItems);
  const approvedQuantity = toNumber(approved?.quantity);
  const approvedValue = roundMoney(approved?.value || approved?.calculatedValue);
  const sentValue = roundMoney(sentTotals.value);
  const quantityDifference = roundMoney(sentTotals.quantity - approvedQuantity);
  const valueDifference = roundMoney(sentValue - approvedValue);
  const firstSent = sentItems[0] || {};
  const isSingleSent = sentItems.length === 1;
  const mappingStatus = statusForMapping({ approved, sentItems, quantityDifference, valueDifference });

  return {
    approvedProductId: approved?.productId || null,
    approvedProductName: approved?.productName || '',
    approvedMRP: toNumber(approved?.mrp),
    approvedQuantity,
    approvedValue,
    sentProductId: isSingleSent ? firstSent.productId || null : null,
    sentProductName: isSingleSent
      ? firstSent.productName || ''
      : sentItems.map((product) => product.productName).filter(Boolean).join(', '),
    sentMRP: isSingleSent ? toNumber(firstSent.mrp) : 0,
    sentQuantity: roundMoney(sentTotals.quantity),
    sentValue,
    sentItems: sentItems.map(sentProductSnapshot),
    quantityDifference,
    valueDifference,
    mappingStatus,
    remark: cleanString(remark),
  };
};

const allocateSentProducts = (approvedProducts, sentProducts) => {
  const used = new Set();
  const mappings = [];

  approvedProducts.forEach((approved, approvedIndex) => {
    let sentItems = sentProducts
      .map((product, index) => ({ product, index }))
      .filter(({ product, index }) => !used.has(index) && productIdentity(product) === productIdentity(approved))
      .map(({ product, index }) => {
        used.add(index);
        return product;
      });

    if (!sentItems.length) {
      const remaining = sentProducts
        .map((product, index) => ({ product, index }))
        .filter(({ index }) => !used.has(index));
      const remainingApprovalCount = approvedProducts.length - approvedIndex;
      const minimumToReserve = Math.max(remainingApprovalCount - 1, 0);
      const canTake = Math.max(remaining.length - minimumToReserve, 0);
      const picked = [];
      let runningQuantity = 0;
      let runningValue = 0;

      for (const item of remaining) {
        if (picked.length >= canTake) break;
        picked.push(item);
        runningQuantity += toNumber(item.product.quantity);
        runningValue += toNumber(item.product.value || item.product.calculatedValue);

        if (
          picked.length > 0
          && runningQuantity >= toNumber(approved.quantity)
          && runningValue >= toNumber(approved.value || approved.calculatedValue)
        ) {
          break;
        }
      }

      sentItems = picked.map(({ product, index }) => {
        used.add(index);
        return product;
      });
    }

    mappings.push(buildMapping(approved, sentItems));
  });

  sentProducts.forEach((sent, index) => {
    if (used.has(index)) return;
    mappings.push({
      ...buildMapping(null, [sent]),
      approvedProductName: '',
      approvedQuantity: 0,
      approvedMRP: 0,
      approvedValue: 0,
    });
  });

  return mappings;
};

const buildAmountApprovalMapping = (approvedValue, sentProducts) => {
  const sentTotals = sumProducts(sentProducts);
  const valueDifference = roundMoney(sentTotals.value - approvedValue);
  let mappingStatus = 'PENDING_REVIEW';

  if (!sentProducts.length) mappingStatus = 'NOT_GIVEN';
  else if (valueDifference === 0) mappingStatus = 'EXACT_MATCH';
  else if (valueDifference < 0) mappingStatus = 'SHORT';
  else mappingStatus = 'EXCESS';

  return [{
    approvedProductId: null,
    approvedProductName: 'Amount Approval',
    approvedMRP: 0,
    approvedQuantity: 0,
    approvedValue,
    sentProductId: sentProducts.length === 1 ? sentProducts[0].productId || null : null,
    sentProductName: sentProducts.length === 1
      ? sentProducts[0].productName || ''
      : sentProducts.map((product) => product.productName).filter(Boolean).join(', '),
    sentMRP: sentProducts.length === 1 ? toNumber(sentProducts[0].mrp) : 0,
    sentQuantity: roundMoney(sentTotals.quantity),
    sentValue: roundMoney(sentTotals.value),
    sentItems: sentProducts.map(sentProductSnapshot),
    quantityDifference: roundMoney(sentTotals.quantity),
    valueDifference,
    mappingStatus,
    remark: '',
  }];
};

const calculateOverallStatus = ({
  currentStatus,
  isLocked,
  totalApprovedValue,
  totalSentValue,
  totalApprovedQuantity,
  totalSentQuantity,
  productMappings,
  sentProducts,
}) => {
  if (isLocked || ['SETTLED', 'REJECTED'].includes(currentStatus)) return currentStatus || 'PENDING';
  if (!sentProducts.length) return 'PENDING';

  const valueDifference = roundMoney(totalSentValue - totalApprovedValue);
  const quantityDifference = roundMoney(totalSentQuantity - totalApprovedQuantity);
  const statuses = productMappings.map((mapping) => mapping.mappingStatus);

  if (
    valueDifference === 0
    && (totalApprovedQuantity === 0 || quantityDifference === 0)
    && statuses.every((status) => ['EXACT_MATCH', 'SUBSTITUTED'].includes(status))
  ) {
    return 'MATCHED';
  }

  if (statuses.some((status) => ['SHORT', 'NOT_GIVEN', 'PARTIAL'].includes(status))) return 'PARTIAL';
  return 'ON_HOLD';
};

const buildMatchDetails = (productMappings = []) => productMappings.map((mapping) => ({
  approvedProduct: mapping.approvedProductName || '',
  sentProduct: mapping.sentProductName || '',
  approvedQty: mapping.approvedQuantity || 0,
  sentQty: mapping.sentQuantity || 0,
  approvedValue: mapping.approvedValue || 0,
  sentValue: mapping.sentValue || 0,
  difference: mapping.valueDifference || 0,
  matchStatus: mapping.mappingStatus === 'EXACT_MATCH' ? 'MATCHED' : mapping.mappingStatus,
}));

const calculateSettlement = (settlementLike = {}) => {
  const approvalType = settlementLike.approvalType || 'Amount';
  const approvedProducts = normalizeProductRows(settlementLike.approvedProducts || []);
  const sentProducts = normalizeProductRows(settlementLike.sentProducts || []);
  const productApprovedValue = sumProducts(approvedProducts).value;
  const approvedAmount = roundMoney(settlementLike.approvedAmount || settlementLike.approvedValue || 0);
  const totalApprovedValue = approvalType === 'Product'
    ? (productApprovedValue || approvedAmount)
    : (approvedAmount || productApprovedValue);
  const approvedTotals = approvalType === 'Product'
    ? sumProducts(approvedProducts)
    : { quantity: sumProducts(approvedProducts).quantity, value: totalApprovedValue };
  const sentTotals = sumProducts(sentProducts);
  const productMappings = approvalType === 'Product' && approvedProducts.length
    ? allocateSentProducts(approvedProducts, sentProducts)
    : buildAmountApprovalMapping(totalApprovedValue, sentProducts);
  const totalValueDifference = roundMoney(sentTotals.value - totalApprovedValue);
  const totalApprovedQuantity = roundMoney(approvedTotals.quantity);
  const totalSentQuantity = roundMoney(sentTotals.quantity);
  const totalQuantityDifference = roundMoney(totalSentQuantity - totalApprovedQuantity);
  const settlementStatus = calculateOverallStatus({
    currentStatus: settlementLike.settlementStatus,
    isLocked: settlementLike.isLocked,
    totalApprovedValue,
    totalSentValue: sentTotals.value,
    totalApprovedQuantity,
    totalSentQuantity,
    productMappings,
    sentProducts,
  });

  return {
    approvedProducts,
    sentProducts,
    productMappings,
    matchDetails: buildMatchDetails(productMappings),
    totalApprovedValue,
    totalSentValue: sentTotals.value,
    totalValueDifference,
    totalApprovedQuantity,
    totalSentQuantity,
    totalQuantityDifference,
    approvedValue: totalApprovedValue,
    sentValue: sentTotals.value,
    difference: totalValueDifference,
    settlementStatus,
  };
};

module.exports = {
  MAPPING_STATUSES,
  calculateProductValue,
  calculateSettlement,
  normalizeProductRows,
  roundMoney,
};
