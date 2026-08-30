const Product = require('../models/product.model');
const Company = require('../models/company.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');
const { applyCompanyScope, assertCompanyAccess, getAllowedCompanyIds } = require('../utils/companyAccess');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeKey = (value) => String(value || '').trim().toLowerCase();
const normalizeHeaderKey = (value) => normalizeKey(value).replace(/\*/g, '').replace(/[^a-z0-9]/g, '');

const productImportHeaders = {
  productname: 'name',
  product: 'name',
  name: 'name',
  itemname: 'name',
  productcode: 'productCode',
  productcodesku: 'productCode',
  productsku: 'productCode',
  code: 'productCode',
  sku: 'sku',
  skucode: 'sku',
  mrp: 'mrp',
  company: 'companyName',
  companyname: 'companyName',
};

const productImportExtensions = new Set(['.xlsx', '.xls', '.csv']);
const productImportMimeTypes = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'application/octet-stream',
  'binary/octet-stream',
  'text/plain',
]);

const cleanCellValue = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && value.text) return String(value.text).trim();
  if (typeof value === 'object' && value.result !== undefined) return String(value.result).trim();
  return String(value).trim();
};

const parseOptionalMrp = (value) => {
  const text = cleanCellValue(value);
  if (!text) return { value: null, blank: true, valid: true };

  const numeric = Number(text.replace(/[\u20b9,\s]/g, ''));
  if (Number.isNaN(numeric) || numeric < 0) {
    return { value: null, blank: false, valid: false };
  }

  return { value: numeric, blank: false, valid: true };
};

const getCompanyKey = (companyId) => String(companyId || 'none');

const validateProductImportFile = (file) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!productImportExtensions.has(ext)) {
    throw ApiError.badRequest('Only .xlsx, .xls, or .csv files are allowed.');
  }

  if (file.mimetype && !productImportMimeTypes.has(file.mimetype)) {
    throw ApiError.badRequest('Only .xlsx, .xls, or .csv files are allowed.');
  }
};

const getUploadedFileBuffer = (file) => {
  if (file.buffer) return file.buffer;
  if (file.path) return fs.readFileSync(file.path);
  throw ApiError.internal('Uploaded file path is unavailable.');
};

const cleanupUploadedFile = async (file) => {
  if (!file?.path) return;
  try {
    await fs.promises.unlink(file.path);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to clean up uploaded file:', error);
  }
};

const parseProductImportRows = (file) => {
  validateProductImportFile(file);

  let workbook;
  try {
    workbook = XLSX.read(getUploadedFileBuffer(file), { type: 'buffer', cellDates: false });
  } catch (error) {
    console.error('Product Excel parse failed:', error);
    throw ApiError.internal('Unable to process the Excel file. Please check the file format and try again.');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw ApiError.badRequest('Excel file is empty.');

  const worksheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false,
  });

  if (!matrix.length) throw ApiError.badRequest('Excel file is empty.');

  const headerRow = matrix[0] || [];
  const headerMap = {};
  headerRow.forEach((header, index) => {
    const mapped = productImportHeaders[normalizeHeaderKey(header)];
    if (mapped && headerMap[mapped] === undefined) headerMap[mapped] = index;
  });

  const hasRecognizedHeaders = Object.keys(headerMap).length > 0;
  const getCell = (row, key, fallbackIndex) => {
    if (headerMap[key] === undefined && hasRecognizedHeaders) return '';
    const index = headerMap[key] !== undefined ? headerMap[key] : fallbackIndex;
    return cleanCellValue(row[index]);
  };

  const rows = matrix.slice(1)
    .map((row, index) => {
      const parsed = {
        row: index + 2,
        name: getCell(row, 'name', 0),
        productCode: getCell(row, 'productCode', 1),
        sku: getCell(row, 'sku', 2),
        mrpText: getCell(row, 'mrp', 3),
        companyName: getCell(row, 'companyName', 4),
      };

      return parsed;
    })
    .filter((row) => row.name || row.productCode || row.sku || row.mrpText || row.companyName);

  if (!rows.length) throw ApiError.badRequest('Excel file is empty.');

  return rows;
};

const resolveSelectedCompanyId = async (req, requestedCompanyId = null) => {
  if (requestedCompanyId) {
    if (!mongoose.Types.ObjectId.isValid(requestedCompanyId)) {
      throw ApiError.badRequest('Invalid company selected.');
    }
    assertCompanyAccess(req.user, requestedCompanyId);

    const company = await Company.findOne({ _id: requestedCompanyId, status: 'active' }).select('_id name').lean();
    if (!company) throw ApiError.badRequest('Selected company is invalid.');
    return String(company._id);
  }

  const allowedCompanyIds = getAllowedCompanyIds(req.user);
  if (allowedCompanyIds && allowedCompanyIds.length === 1) {
    return allowedCompanyIds[0];
  }

  return null;
};

const getSelectedCompanyId = async (req) => resolveSelectedCompanyId(req, req.body.companyId || null);

const getCompanyMaps = async () => {
  const companies = await Company.find({ status: 'active' }).select('_id name').lean();
  const byId = new Map();
  const byName = new Map();

  companies.forEach((company) => {
    byId.set(String(company._id), company);
    byName.set(normalizeKey(company.name), company);
  });

  return { byId, byName };
};

const resolveImportCompany = ({ row, selectedCompanyId, companyMaps, user }) => {
  if (row.companyName) {
    const company = companyMaps.byName.get(normalizeKey(row.companyName));
    if (!company) return { companyId: null, companyName: row.companyName, error: 'Invalid company' };

    const rowCompanyId = String(company._id);
    try {
      assertCompanyAccess(user, rowCompanyId);
    } catch (error) {
      return { companyId: rowCompanyId, companyName: company.name, error: error.message };
    }

    if (selectedCompanyId && selectedCompanyId !== rowCompanyId) {
      return { companyId: rowCompanyId, companyName: company.name, error: 'Company does not match selected company' };
    }

    return { companyId: rowCompanyId, companyName: company.name, error: null };
  }

  if (selectedCompanyId) {
    const selectedCompany = companyMaps.byId.get(selectedCompanyId);
    return {
      companyId: selectedCompanyId,
      companyName: selectedCompany?.name || '',
      error: null,
    };
  }

  const allowedCompanyIds = getAllowedCompanyIds(user);
  if (allowedCompanyIds && allowedCompanyIds.length > 1) {
    return { companyId: null, companyName: '', error: 'Company is required' };
  }

  return { companyId: null, companyName: '', error: null };
};

const buildProductImportPreview = async (req, rows) => {
  const selectedCompanyId = await getSelectedCompanyId(req);
  const companyMaps = await getCompanyMaps();
  const existingProducts = await Product.find({})
    .select('name productName sku productCode code companyId')
    .lean();

  const existingNameKeys = new Set();
  const existingSkuKeys = new Set();
  const existingCodeKeys = new Set();

  existingProducts.forEach((product) => {
    const companyKey = getCompanyKey(product.companyId);
    const names = [product.name, product.productName].map(normalizeKey).filter(Boolean);
    names.forEach((name) => existingNameKeys.add(`${companyKey}:${name}`));

    const sku = normalizeKey(product.sku);
    if (sku) existingSkuKeys.add(`${companyKey}:${sku}`);

    [product.productCode, product.code].map(normalizeKey).filter(Boolean)
      .forEach((code) => existingCodeKeys.add(`${companyKey}:${code}`));
  });

  const seenNames = new Set();
  const seenSkus = new Set();
  const seenCodes = new Set();

  const preview = rows.map((row) => {
    const errors = [];
    const mrp = parseOptionalMrp(row.mrpText);
    const company = resolveImportCompany({ row, selectedCompanyId, companyMaps, user: req.user });
    const companyKey = getCompanyKey(company.companyId);
    const nameKey = normalizeKey(row.name);
    const skuKey = normalizeKey(row.sku);
    const codeKey = normalizeKey(row.productCode);

    if (!row.name) errors.push('Product name is required');
    if (!mrp.valid) errors.push('Invalid MRP');
    if (company.error) errors.push(company.error);

    if (nameKey) {
      const key = `${companyKey}:${nameKey}`;
      if (existingNameKeys.has(key)) errors.push('Product already exists');
      if (seenNames.has(key)) errors.push('Duplicate product in Excel');
      seenNames.add(key);
    }

    if (skuKey) {
      const key = `${companyKey}:${skuKey}`;
      if (existingSkuKeys.has(key)) errors.push('SKU already exists');
      if (seenSkus.has(key)) errors.push('Duplicate SKU in Excel');
      seenSkus.add(key);
    }

    if (codeKey) {
      const key = `${companyKey}:${codeKey}`;
      if (existingCodeKeys.has(key)) errors.push('Product code already exists');
      if (seenCodes.has(key)) errors.push('Duplicate product code in Excel');
      seenCodes.add(key);
    }

    return {
      row: row.row,
      name: row.name,
      productName: row.name,
      productCode: row.productCode,
      sku: row.sku,
      mrp: mrp.blank ? null : mrp.value,
      companyId: company.companyId,
      companyName: company.companyName,
      status: errors.length ? 'Invalid' : 'Valid',
      errors,
      error: errors[0] || '',
      reason: errors.join('; '),
    };
  });

  const validRows = preview.filter((row) => row.status === 'Valid');
  const invalidRows = preview.filter((row) => row.status === 'Invalid');

  return {
    preview,
    validRows,
    invalidRows,
    validCount: validRows.length,
    errorCount: invalidRows.length,
    totalRows: preview.length,
  };
};

const handleProductImportError = (error, next, context) => {
  if (error instanceof ApiError) return next(error);
  console.error(context, error);
  return next(ApiError.internal('Unable to process the Excel file. Please check the file format and try again.'));
};

const getSearchRegex = (req) => {
  const term = String(req.query.search || req.query.q || '').trim();
  return term ? new RegExp(escapeRegExp(term), 'i') : null;
};

const normalizeProduct = (product, source = 'master') => ({
  _id: product._id,
  productId: product._id,
  name: product.name || product.productName || '',
  productName: product.productName || product.name || '',
  sku: product.sku || '',
  productCode: product.productCode || product.code || '',
  code: product.code || product.productCode || '',
  mrp: Number(product.mrp || 0),
  companyId: product.companyId || product.company || null,
  status: product.status || 'active',
  source,
});

// GET /api/products — Paginated product list (Product Register)
const getProducts = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || paginationConfig.defaultPage, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || paginationConfig.defaultLimit, 1), paginationConfig.maxLimit);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.companyId) {
      assertCompanyAccess(req.user, req.query.companyId);
      filter.companyId = req.query.companyId;
    } else {
      applyCompanyScope(filter, req.user, 'companyId');
    }

    if (req.query.search) {
      const regex = new RegExp(escapeRegExp(req.query.search), 'i');
      filter.$or = [
        { name: regex },
        { productName: regex },
        { sku: regex },
        { productCode: regex },
        { code: regex },
      ];
    }

    const [products, total] = await Promise.all([
      Product.find(filter)
        .select('name productName sku productCode code mrp companyId status createdAt')
        .populate('companyId', 'name')
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, products, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
};

// GET /api/products/:id
const getProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id).populate('companyId', 'name');
    if (!product) throw ApiError.notFound('Product not found');
    ApiResponse.success(res, product);
  } catch (error) {
    next(error);
  }
};

// POST /api/products
const createProduct = async (req, res, next) => {
  try {
    const { name, productName, sku, productCode, code, mrp, companyId, company, status } = req.body;
    const finalName = name || productName;
    if (!finalName) throw ApiError.badRequest('Product name is required');

    const finalCompanyId = await resolveSelectedCompanyId(req, companyId || company || null);

    // Duplicate check
    const existing = await Product.findOne({
      name: { $regex: `^${escapeRegExp(finalName.trim())}$`, $options: 'i' },
      companyId: finalCompanyId || null,
    });
    if (existing) throw ApiError.conflict(`Product "${finalName}" already exists`);

    const product = await Product.create({
      name: finalName,
      productName: finalName,
      sku: sku || '',
      productCode: productCode || code || '',
      code: code || productCode || '',
      mrp: mrp !== undefined && mrp !== '' ? Number(mrp) : 0,
      companyId: finalCompanyId,
      company: finalCompanyId,
      status: status === 'inactive' ? 'inactive' : 'active',
    });

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'CREATE', entity: 'Product', entityId: product._id,
      description: `Created product: ${finalName}`,
      newValue: { name: finalName, sku, productCode, mrp }, ...clientInfo,
    });

    ApiResponse.created(res, product, 'Product created successfully');
  } catch (error) {
    next(error);
  }
};

// PUT /api/products/:id
const updateProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');

    const oldValue = product.toObject();
    const { name, productName, sku, productCode, code, mrp, companyId, company, status } = req.body;

    if (name !== undefined) { product.name = name; product.productName = name; }
    if (productName !== undefined) { product.productName = productName; product.name = productName; }
    if (sku !== undefined) product.sku = sku;
    if (productCode !== undefined) { product.productCode = productCode; product.code = productCode; }
    if (code !== undefined) { product.code = code; product.productCode = code; }
    if (mrp !== undefined) product.mrp = mrp !== '' ? Number(mrp) : 0;
    if (companyId !== undefined) { product.companyId = companyId || null; product.company = companyId || null; }
    if (company !== undefined) { product.company = company || null; product.companyId = company || null; }
    if (status !== undefined) product.status = status;

    await product.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'UPDATE', entity: 'Product', entityId: product._id,
      description: `Updated product: ${product.name}`,
      oldValue, newValue: product.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, product, 'Product updated successfully');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/products/:id - deactivate only; historical transactions keep their snapshots.
const deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');

    const oldValue = product.toObject();
    product.status = 'inactive';
    await product.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'DEACTIVATE', entity: 'Product', entityId: product._id,
      description: `Deactivated product: ${product.name}`,
      oldValue, newValue: product.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, product, 'Product deactivated successfully');
  } catch (error) {
    next(error);
  }
};

// GET /api/products/search — Searchable dropdown endpoint
const searchProducts = async (req, res, next) => {
  try {
    const regex = getSearchRegex(req);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
    const skip = (page - 1) * limit;
    const companyId = req.query.companyId || req.query.company || '';
    const productFilter = { status: 'active' };

    if (companyId) {
      assertCompanyAccess(req.user, companyId);
      productFilter.companyId = companyId;
    } else {
      applyCompanyScope(productFilter, req.user, 'companyId');
    }

    if (regex) {
      productFilter.$or = [
        { name: regex },
        { productName: regex },
        { sku: regex },
        { productCode: regex },
        { code: regex },
      ];
    }

    const [masterProducts, total] = await Promise.all([
      Product.find(productFilter)
        .select('name productName sku productCode code mrp companyId status')
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(productFilter),
    ]);

    const allProducts = masterProducts.map((p) => normalizeProduct(p, 'master'));

    ApiResponse.success(res, {
      items: allProducts,
      page,
      limit,
      total,
      hasMore: skip + limit < total,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/products/sample-excel
const downloadSampleExcel = async (req, res, next) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Products');

    sheet.columns = [
      { header: 'Product Name *', key: 'name', width: 35 },
      { header: 'Product Code', key: 'productCode', width: 20 },
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'MRP', key: 'mrp', width: 12 },
      { header: 'Company', key: 'company', width: 25 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };

    sheet.addRow({ name: 'CTC-1468', productCode: 'CTC1468', sku: 'CTC-1468-100', mrp: 100, company: 'Company A' });
    sheet.addRow({ name: 'ATCC-1500', productCode: 'ATCC1500', sku: 'ATCC-1500-150', mrp: 150, company: 'Company A' });
    sheet.addRow({ name: '250g Kashmiri Chilli Powder', productCode: 'KCP250', sku: '', mrp: '', company: 'Company A' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=product_sample.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

// POST /api/products/import/preview — Preview import before saving
const previewImport = async (req, res, next) => {
  try {
    if (!req.file) throw ApiError.badRequest('Excel file is required.');

    const rows = parseProductImportRows(req.file);
    const result = await buildProductImportPreview(req, rows);

    ApiResponse.success(res, {
      preview: result.preview,
      validCount: result.validCount,
      errorCount: result.errorCount,
      totalRows: result.totalRows,
    }, 'Excel parsed successfully');
  } catch (error) {
    handleProductImportError(error, next, 'Product import preview failed:');
  } finally {
    await cleanupUploadedFile(req.file);
  }
};

// POST /api/products/import
const importProducts = async (req, res, next) => {
  try {
    if (!req.file) throw ApiError.badRequest('Excel file is required.');

    const rows = parseProductImportRows(req.file);
    const validation = await buildProductImportPreview(req, rows);
    const productsToInsert = validation.validRows.map((row) => ({
      name: row.name,
      productName: row.name,
      productCode: row.productCode,
      code: row.productCode,
      sku: row.sku,
      mrp: row.mrp === null ? 0 : row.mrp,
      companyId: row.companyId || null,
      company: row.companyId || null,
      status: 'active',
    }));

    if (!productsToInsert.length) {
      throw ApiError.badRequest('No valid product rows to import.', validation.invalidRows);
    }

    const insertedProducts = await Product.insertMany(productsToInsert, { ordered: false });
    const results = {
      inserted: insertedProducts.length,
      updated: 0,
      skipped: validation.invalidRows.length,
      errors: validation.invalidRows.map((row) => ({
        row: row.row,
        name: row.name,
        productName: row.name,
        error: row.error,
        reason: row.reason,
        message: row.reason,
      })),
      preview: validation.preview,
    };

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'IMPORT', entity: 'Product',
      description: `Imported products: ${results.inserted} inserted, ${results.skipped} skipped, ${results.errors.length} errors`,
      newValue: results, ...clientInfo,
    });

    ApiResponse.success(res, results, 'Products imported successfully');
  } catch (error) {
    handleProductImportError(error, next, 'Product import failed:');
  } finally {
    await cleanupUploadedFile(req.file);
  }
};

module.exports = {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  searchProducts,
  downloadSampleExcel,
  previewImport,
  importProducts,
};
