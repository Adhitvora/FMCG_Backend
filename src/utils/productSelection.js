const mongoose = require('mongoose');
const Product = require('../models/product.model');
const ApiError = require('./apiError');
const { assertCompanyAccess } = require('./companyAccess');

const toStringId = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  return String(value);
};

const hasProductPayload = (row = {}) => Boolean(
  row.productId
  || row.productName
  || row.productNameSnapshot
  || row.name
  || row.mrp
  || row.mrpSnapshot
  || row.quantity
  || row.value
  || row.totalValue
  || row.calculatedValue
);

const parseProductRows = (rows = []) => {
  if (typeof rows === 'string' && rows.trim()) {
    try {
      return JSON.parse(rows);
    } catch (error) {
      throw ApiError.badRequest('Invalid product rows payload.');
    }
  }
  return Array.isArray(rows) ? rows : [];
};

const validateActiveProductSelections = async ({
  rows = [],
  user,
  companyId,
  label = 'Product',
}) => {
  const incomingRows = parseProductRows(rows).filter(hasProductPayload);

  if (!incomingRows.length) return [];
  if (companyId) assertCompanyAccess(user, companyId);

  incomingRows.forEach((row, index) => {
    if (!row.productId) throw ApiError.badRequest(`${label} row ${index + 1}: productId is required.`);
    if (!mongoose.Types.ObjectId.isValid(row.productId)) throw ApiError.badRequest(`${label} row ${index + 1}: invalid productId.`);
  });

  const ids = [...new Set(incomingRows.map((row) => String(row.productId)))];
  const products = await Product.find({ _id: { $in: ids }, status: 'active' })
    .select('name productName sku productCode code mrp companyId status')
    .lean();
  const productById = new Map(products.map((product) => [String(product._id), product]));

  return incomingRows.map((row, index) => {
    const product = productById.get(String(row.productId));
    if (!product) throw ApiError.badRequest(`${label} row ${index + 1}: selected product is inactive or does not exist.`);

    if (product.companyId) {
      assertCompanyAccess(user, product.companyId);
      if (companyId && toStringId(product.companyId) !== toStringId(companyId)) {
        throw ApiError.badRequest(`${label} row ${index + 1}: selected product does not belong to this company.`);
      }
    }

    const productNameSnapshot = String(product.productName || product.name || '').trim();
    const mrp = row.mrp !== undefined && row.mrp !== '' ? Number(row.mrp) : Number(row.mrpSnapshot || product.mrp || 0);

    return {
      ...row,
      productId: product._id,
      productName: productNameSnapshot,
      productNameSnapshot,
      sku: product.sku || '',
      productCode: product.productCode || product.code || '',
      code: product.code || product.productCode || '',
      mrp,
      mrpSnapshot: mrp,
      masterMrpSnapshot: Number(product.mrp || 0),
    };
  });
};

module.exports = {
  parseProductRows,
  validateActiveProductSelections,
};
