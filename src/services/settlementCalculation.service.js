const ApiError = require('../utils/apiError');

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

const CALCULATION_MODES = {
  QTY: 'QTY',
  VALUE: 'VALUE',
};

const MRP_SCALE = 4;
const QTY_SCALE = 4;
const VALUE_SCALE = 2;

const pow10 = (scale) => 10n ** BigInt(scale);

const parseDecimalUnits = (value, scale, fieldName = 'Value', { blankAsZero = true } = {}) => {
  if (value === undefined || value === '') return blankAsZero ? 0n : null;
  if (value === null) throw ApiError.badRequest(`${fieldName} is required.`);

  const text = String(value).trim().replace(/,/g, '');
  if (!text) return blankAsZero ? 0n : null;
  if (text.startsWith('-')) throw ApiError.badRequest(`${fieldName} must be greater than or equal to 0.`);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw ApiError.badRequest(`${fieldName} must be a valid number.`);

  const [wholeRaw = '0', fractionRaw = ''] = text.split('.');
  const whole = wholeRaw || '0';
  const fraction = fractionRaw.slice(0, scale).padEnd(scale, '0');
  const roundDigit = Number(fractionRaw[scale] || 0);
  let units = BigInt(whole) * pow10(scale) + BigInt(fraction || '0');
  if (roundDigit >= 5) units += 1n;
  return units;
};

const roundDivide = (numerator, denominator) => {
  if (denominator <= 0n) return null;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
};

const roundScale = (units, fromScale, toScale) => {
  if (fromScale === toScale) return units;
  if (fromScale < toScale) return units * pow10(toScale - fromScale);
  return roundDivide(units, pow10(fromScale - toScale));
};

const formatUnits = (units, scale) => {
  const divisor = pow10(scale);
  const whole = units / divisor;
  const fraction = String(units % divisor).padStart(scale, '0');
  return scale === 0 ? String(whole) : `${whole}.${fraction}`;
};

const unitsToNumber = (units, scale) => Number(formatUnits(units || 0n, scale));

const roundDecimal = (value, scale) => {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  const sign = number < 0 ? -1 : 1;
  const fixed = Math.abs(number).toFixed(scale + 6);
  const units = parseDecimalUnits(fixed, scale);
  return sign * unitsToNumber(units, scale);
};

const roundMoney = (value) => roundDecimal(value, VALUE_SCALE);

const roundQuantity = (value) => roundDecimal(value, QTY_SCALE);

const toNumber = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
};

const normalizeCalculationMode = (mode) => (
  mode === CALCULATION_MODES.QTY || mode === CALCULATION_MODES.VALUE ? mode : ''
);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const explicitValueSource = (product = {}) => {
  if (hasOwn(product, 'value')) return product.value;
  if (hasOwn(product, 'calculatedValue')) return product.calculatedValue;
  if (hasOwn(product, 'totalValue')) return product.totalValue;
  return undefined;
};

const validateProvidedNumericFields = (product = {}, fieldPrefix = 'Product row') => {
  [
    ['mrp', 'MRP', MRP_SCALE],
    ['mrpSnapshot', 'MRP snapshot', MRP_SCALE],
    ['masterMrpSnapshot', 'Master MRP snapshot', MRP_SCALE],
    ['quantity', 'Qty', QTY_SCALE],
    ['value', 'Value', VALUE_SCALE],
    ['calculatedValue', 'Calculated value', VALUE_SCALE],
    ['totalValue', 'Total value', VALUE_SCALE],
  ].forEach(([key, label, scale]) => {
    if (hasOwn(product, key) && product[key] !== undefined && product[key] !== '') {
      parseDecimalUnits(product[key], scale, `${fieldPrefix} ${label}`);
    }
  });
};

const parseProductRowsInput = (rows = []) => {
  if (typeof rows === 'string' && rows.trim()) {
    try {
      return JSON.parse(rows);
    } catch (error) {
      throw ApiError.badRequest('Invalid product rows payload.');
    }
  }
  return Array.isArray(rows) ? rows : [];
};

const validateProductRowsNumericPayload = (rows = [], options = {}) => {
  parseProductRowsInput(rows).forEach((product, index) => {
    const fieldPrefix = options.label ? `${options.label} ${index + 1}:` : `Product row ${index + 1}:`;
    validateProvidedNumericFields(product, fieldPrefix);
  });
};

const calculateValueFromQtyUnits = (mrpUnits, quantityUnits) => (
  roundScale(mrpUnits * quantityUnits, MRP_SCALE + QTY_SCALE, VALUE_SCALE)
);

const calculateQtyFromValueUnits = (valueUnits, mrpUnits) => {
  if (mrpUnits <= 0n) return 0n;
  return roundDivide(valueUnits * pow10(MRP_SCALE + QTY_SCALE - VALUE_SCALE), mrpUnits);
};

const cleanString = (value) => String(value || '').trim();

const productIdentity = (product = {}) => {
  if (product.productId) return `id:${String(product.productId)}`;
  return `name:${cleanString(product.productName || product.name).toLowerCase()}`;
};

const productNameKey = (product = {}) => cleanString(product.productName || product.name).toLowerCase();

const calculateProductValue = (product = {}, options = {}) => {
  const mrpUnits = parseDecimalUnits(product.mrp, MRP_SCALE, 'MRP');
  const quantityUnits = parseDecimalUnits(product.quantity, QTY_SCALE, 'Qty');
  const mode = options.useCalculationMode ? normalizeCalculationMode(product.calculationMode) : '';

  if (mode === CALCULATION_MODES.VALUE) {
    const source = explicitValueSource(product);
    const valueUnits = parseDecimalUnits(source, VALUE_SCALE, 'Value');
    return unitsToNumber(valueUnits, VALUE_SCALE);
  }

  const calculatedUnits = calculateValueFromQtyUnits(mrpUnits, quantityUnits);
  if (mode === CALCULATION_MODES.QTY) return unitsToNumber(calculatedUnits, VALUE_SCALE);

  const source = explicitValueSource(product);
  if (source !== undefined && source !== null && source !== '') {
    const explicitUnits = parseDecimalUnits(source, VALUE_SCALE, 'Value');
    if (explicitUnits > 0n) return unitsToNumber(explicitUnits, VALUE_SCALE);
  }

  return unitsToNumber(calculatedUnits, VALUE_SCALE);
};

const normalizeProductRow = (product = {}, options = {}, index = 0) => {
  const fieldPrefix = options.label ? `${options.label} ${index + 1}:` : `Product row ${index + 1}:`;
  if (options.strictNumeric) validateProvidedNumericFields(product, fieldPrefix);

  const mrpUnits = parseDecimalUnits(product.mrp, MRP_SCALE, `${fieldPrefix} MRP`);
  let quantityUnits = parseDecimalUnits(product.quantity, QTY_SCALE, `${fieldPrefix} Qty`);
  let valueUnits;
  const calculationMode = normalizeCalculationMode(product.calculationMode);
  const mode = options.useCalculationMode ? calculationMode : '';

  if (mode === CALCULATION_MODES.VALUE) {
    valueUnits = parseDecimalUnits(explicitValueSource(product), VALUE_SCALE, `${fieldPrefix} Value`);
    quantityUnits = calculateQtyFromValueUnits(valueUnits, mrpUnits);
  } else if (mode === CALCULATION_MODES.QTY) {
    valueUnits = calculateValueFromQtyUnits(mrpUnits, quantityUnits);
  } else {
    const calculatedUnits = calculateValueFromQtyUnits(mrpUnits, quantityUnits);
    const source = explicitValueSource(product);
    if (source !== undefined && source !== null && source !== '') {
      const explicitUnits = parseDecimalUnits(source, VALUE_SCALE, `${fieldPrefix} Value`);
      valueUnits = explicitUnits > 0n ? explicitUnits : calculatedUnits;
    } else {
      valueUnits = calculatedUnits;
    }
  }

  const mrp = unitsToNumber(mrpUnits, MRP_SCALE);
  const quantity = unitsToNumber(quantityUnits, QTY_SCALE);
  const value = unitsToNumber(valueUnits, VALUE_SCALE);

  return {
    productId: product.productId || null,
    productName: cleanString(product.productName || product.productNameSnapshot || product.name),
    productNameSnapshot: cleanString(product.productNameSnapshot || product.productName || product.name),
    sku: cleanString(product.sku),
    productCode: cleanString(product.productCode || product.code),
    mrp,
    mrpSnapshot: unitsToNumber(parseDecimalUnits(product.mrpSnapshot || mrp, MRP_SCALE, `${fieldPrefix} MRP snapshot`), MRP_SCALE),
    masterMrpSnapshot: unitsToNumber(parseDecimalUnits(product.masterMrpSnapshot || 0, MRP_SCALE, `${fieldPrefix} Master MRP snapshot`), MRP_SCALE),
    quantity,
    unit: cleanString(product.unit) || 'pcs',
    value,
    calculatedValue: value,
    calculationMode: calculationMode || undefined,
    batchNo: cleanString(product.batchNo),
    expiryDate: product.expiryDate || null,
    remarks: cleanString(product.remarks),
  };
};

const normalizeProductRows = (rows = [], options = {}) => {
  rows = parseProductRowsInput(rows);
  if (!Array.isArray(rows)) return [];

  return rows
    .map((product, index) => normalizeProductRow(product, options, index))
    .filter((product) => product.productName || product.mrp || product.quantity || product.value);
};

const sumProducts = (products = []) => products.reduce((totals, product) => {
  totals.quantity = roundQuantity(totals.quantity + toNumber(product.quantity));
  totals.value = roundMoney(totals.value + toNumber(product.value || product.calculatedValue));
  return totals;
}, { quantity: 0, value: 0 });

const sentProductSnapshot = (product = {}) => ({
  sentProductId: product.productId || null,
  sentProductName: product.productName || '',
  sentProductNameSnapshot: product.productNameSnapshot || product.productName || '',
  sentMRP: toNumber(product.mrp),
  sentMRPSnapshot: toNumber(product.mrpSnapshot || product.mrp),
  sentQuantity: roundQuantity(product.quantity),
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
  const approvedQuantity = roundQuantity(approved?.quantity);
  const approvedValue = roundMoney(approved?.value || approved?.calculatedValue);
  const sentValue = roundMoney(sentTotals.value);
  const quantityDifference = roundQuantity(sentTotals.quantity - approvedQuantity);
  const valueDifference = roundMoney(sentValue - approvedValue);
  const firstSent = sentItems[0] || {};
  const isSingleSent = sentItems.length === 1;
  const mappingStatus = statusForMapping({ approved, sentItems, quantityDifference, valueDifference });

  return {
    approvedProductId: approved?.productId || null,
    approvedProductName: approved?.productName || '',
    approvedProductNameSnapshot: approved?.productNameSnapshot || approved?.productName || '',
    approvedMRP: toNumber(approved?.mrp),
    approvedMRPSnapshot: toNumber(approved?.mrpSnapshot || approved?.mrp),
    approvedQuantity,
    approvedValue,
    sentProductId: isSingleSent ? firstSent.productId || null : null,
    sentProductName: isSingleSent
      ? firstSent.productName || ''
      : sentItems.map((product) => product.productName).filter(Boolean).join(', '),
    sentProductNameSnapshot: isSingleSent
      ? firstSent.productNameSnapshot || firstSent.productName || ''
      : sentItems.map((product) => product.productNameSnapshot || product.productName).filter(Boolean).join(', '),
    sentMRP: isSingleSent ? toNumber(firstSent.mrp) : 0,
    sentMRPSnapshot: isSingleSent ? toNumber(firstSent.mrpSnapshot || firstSent.mrp) : 0,
    sentQuantity: roundQuantity(sentTotals.quantity),
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
    approvedProductNameSnapshot: 'Amount Approval',
    approvedMRP: 0,
    approvedMRPSnapshot: 0,
    approvedQuantity: 0,
    approvedValue,
    sentProductId: sentProducts.length === 1 ? sentProducts[0].productId || null : null,
    sentProductName: sentProducts.length === 1
      ? sentProducts[0].productName || ''
      : sentProducts.map((product) => product.productName).filter(Boolean).join(', '),
    sentProductNameSnapshot: sentProducts.length === 1
      ? sentProducts[0].productNameSnapshot || sentProducts[0].productName || ''
      : sentProducts.map((product) => product.productNameSnapshot || product.productName).filter(Boolean).join(', '),
    sentMRP: sentProducts.length === 1 ? toNumber(sentProducts[0].mrp) : 0,
    sentMRPSnapshot: sentProducts.length === 1 ? toNumber(sentProducts[0].mrpSnapshot || sentProducts[0].mrp) : 0,
    sentQuantity: roundQuantity(sentTotals.quantity),
    sentValue: roundMoney(sentTotals.value),
    sentItems: sentProducts.map(sentProductSnapshot),
    quantityDifference: roundQuantity(sentTotals.quantity),
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
  const quantityDifference = roundQuantity(totalSentQuantity - totalApprovedQuantity);
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
  const sentProducts = normalizeProductRows(settlementLike.sentProducts || [], {
    label: 'Sent product row',
    strictNumeric: true,
    useCalculationMode: true,
  });
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
  const totalApprovedQuantity = roundQuantity(approvedTotals.quantity);
  const totalSentQuantity = roundQuantity(sentTotals.quantity);
  const totalQuantityDifference = roundQuantity(totalSentQuantity - totalApprovedQuantity);
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
  CALCULATION_MODES,
  MAPPING_STATUSES,
  calculateProductValue,
  calculateSettlement,
  normalizeProductRows,
  roundMoney,
  roundQuantity,
  validateProductRowsNumericPayload,
};
