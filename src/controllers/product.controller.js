const Product = require('../models/product.model');
const Replacement = require('../models/replacement.model');
const Settlement = require('../models/settlement.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');
const { applyCompanyScope, assertCompanyAccess } = require('../utils/companyAccess');
const ExcelJS = require('exceljs');

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getSearchRegex = (req) => {
  const term = String(req.query.search || req.query.q || '').trim();
  return term ? new RegExp(escapeRegExp(term), 'i') : null;
};

const normalizeProduct = (product, source = 'master') => ({
  _id: product._id || `${source}:${product.companyId || product.company || 'any'}:${product.productName || product.name}:${product.mrp || 0}`,
  productId: product._id || product.productId || null,
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

const addUniqueProduct = (target, product) => {
  const key = [
    String(product.productId || ''),
    String(product.productName || product.name || '').trim().toLowerCase(),
    Number(product.mrp || 0),
    String(product.companyId || ''),
  ].join('|');

  if (!product.productName && !product.name) return;
  if (target.has(key)) return;
  target.set(key, product);
};

const getHistoricalProducts = async ({ regex, companyId, user, limit }) => {
  const replacementFilter = {};
  const settlementFilter = {};

  if (companyId) {
    assertCompanyAccess(user, companyId);
    replacementFilter.company = companyId;
    settlementFilter.companyId = companyId;
  } else {
    applyCompanyScope(replacementFilter, user, 'company');
    applyCompanyScope(settlementFilter, user, 'companyId');
  }

  const [replacements, settlements] = await Promise.all([
    Replacement.find({
      ...replacementFilter,
      approvalProducts: { $elemMatch: regex ? { productName: regex } : { productName: { $exists: true, $ne: '' } } },
    }).select('company approvalProducts').sort({ updatedAt: -1 }).limit(limit).lean(),
    Settlement.find({
      ...settlementFilter,
      $or: [
        { approvedProducts: { $elemMatch: regex ? { productName: regex } : { productName: { $exists: true, $ne: '' } } } },
        { sentProducts: { $elemMatch: regex ? { productName: regex } : { productName: { $exists: true, $ne: '' } } } },
      ],
    }).select('companyId approvedProducts sentProducts').sort({ updatedAt: -1 }).limit(limit).lean(),
  ]);

  const rows = [];
  replacements.forEach((replacement) => {
    (replacement.approvalProducts || []).forEach((product) => {
      if (regex && !regex.test(product.productName || '')) return;
      rows.push(normalizeProduct({
        ...product,
        name: product.productName,
        companyId: replacement.company,
      }, 'approval_history'));
    });
  });

  settlements.forEach((settlement) => {
    [...(settlement.approvedProducts || []), ...(settlement.sentProducts || [])].forEach((product) => {
      if (regex && !regex.test(product.productName || '')) return;
      rows.push(normalizeProduct({
        ...product,
        name: product.productName,
        companyId: settlement.companyId,
      }, 'settlement_history'));
    });
  });

  return rows;
};

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
    const { name, productName, sku, productCode, code, mrp, companyId, company } = req.body;
    const finalName = name || productName;
    if (!finalName) throw ApiError.badRequest('Product name is required');

    const finalCompanyId = companyId || company || null;
    if (finalCompanyId) assertCompanyAccess(req.user, finalCompanyId);

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

// DELETE /api/products/:id
const deleteProduct = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw ApiError.notFound('Product not found');

    await Product.findByIdAndDelete(req.params.id);

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'DELETE', entity: 'Product', entityId: product._id,
      description: `Deleted product: ${product.name}`,
      oldValue: product.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, null, 'Product deleted successfully');
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
        .select('name productName sku productCode code mrp companyId')
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(productFilter),
    ]);

    // Only fetch historical on first page with a search term
    let allProducts;
    if (page === 1 && regex) {
      const historicalProducts = await getHistoricalProducts({ regex, companyId, user: req.user, limit: 20 });
      const uniqueProducts = new Map();
      masterProducts.forEach((product) => addUniqueProduct(uniqueProducts, normalizeProduct(product, 'master')));
      historicalProducts.forEach((product) => addUniqueProduct(uniqueProducts, product));
      allProducts = [...uniqueProducts.values()].slice(0, limit);
    } else {
      allProducts = masterProducts.map((p) => normalizeProduct(p, 'master'));
    }

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
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' } };

    sheet.addRow({ name: 'CTC-1468', productCode: 'CTC1468', sku: 'CTC-1468-100', mrp: 100 });
    sheet.addRow({ name: 'ATCC-1500', productCode: 'ATCC1500', sku: 'ATCC-1500-150', mrp: 150 });
    sheet.addRow({ name: '250g Kashmiri Chilli Powder', productCode: 'KCP250', sku: '', mrp: '' });

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
    if (!req.file) throw ApiError.badRequest('Excel/CSV file is required');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.getWorksheet(1);
    if (!sheet) throw ApiError.badRequest('No worksheet found');

    const preview = [];
    const existingNames = new Set();

    // Pre-fetch existing products for duplicate detection
    const allProducts = await Product.find({}).select('name companyId').lean();
    allProducts.forEach((p) => existingNames.add(String(p.name || '').trim().toLowerCase()));

    const seenInFile = new Set();

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const name = row.getCell(1).value?.toString()?.trim() || '';
      const productCode = row.getCell(2).value?.toString()?.trim() || '';
      const sku = row.getCell(3).value?.toString()?.trim() || '';
      const mrpRaw = row.getCell(4).value;
      const mrp = mrpRaw !== undefined && mrpRaw !== null && mrpRaw !== '' ? Number(mrpRaw) : null;

      const errors = [];
      if (!name) errors.push('Product name is required');
      if (mrp !== null && (isNaN(mrp) || mrp < 0)) errors.push('Invalid MRP');
      if (name && existingNames.has(name.toLowerCase())) errors.push('Duplicate product in database');
      if (name && seenInFile.has(name.toLowerCase())) errors.push('Duplicate in file');

      if (name) seenInFile.add(name.toLowerCase());

      preview.push({
        row: rowNumber,
        name,
        productCode,
        sku,
        mrp: mrp !== null && !isNaN(mrp) ? mrp : null,
        status: errors.length === 0 ? 'valid' : 'error',
        errors,
      });
    });

    const validCount = preview.filter((r) => r.status === 'valid').length;
    const errorCount = preview.filter((r) => r.status === 'error').length;

    ApiResponse.success(res, { preview, validCount, errorCount, totalRows: preview.length });
  } catch (error) {
    next(error);
  }
};

// POST /api/products/import
const importProducts = async (req, res, next) => {
  try {
    if (!req.file) throw ApiError.badRequest('Excel/CSV file is required');

    const companyId = req.body.companyId || null;
    if (companyId) assertCompanyAccess(req.user, companyId);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const sheet = workbook.getWorksheet(1);
    if (!sheet) throw ApiError.badRequest('No worksheet found');

    const results = { inserted: 0, skipped: 0, errors: [] };
    const rows = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const name = row.getCell(1).value?.toString()?.trim() || '';
      const productCode = row.getCell(2).value?.toString()?.trim() || '';
      const sku = row.getCell(3).value?.toString()?.trim() || '';
      const mrpRaw = row.getCell(4).value;
      const mrp = mrpRaw !== undefined && mrpRaw !== null && mrpRaw !== '' ? Number(mrpRaw) : 0;

      if (!name) {
        results.errors.push({ row: rowNumber, name: '', message: 'Product name is required' });
        return;
      }
      if (isNaN(mrp) || mrp < 0) {
        results.errors.push({ row: rowNumber, name, message: 'Invalid MRP value' });
        return;
      }

      rows.push({ rowNumber, name, productCode, sku, mrp });
    });

    for (const row of rows) {
      try {
        const existing = await Product.findOne({
          name: { $regex: `^${escapeRegExp(row.name)}$`, $options: 'i' },
          companyId: companyId || null,
        });

        if (existing) {
          results.skipped++;
          results.errors.push({ row: row.rowNumber, name: row.name, message: 'Product already exists' });
        } else {
          await Product.create({
            name: row.name,
            productName: row.name,
            productCode: row.productCode,
            code: row.productCode,
            sku: row.sku,
            mrp: row.mrp,
            companyId: companyId,
            company: companyId,
          });
          results.inserted++;
        }
      } catch (err) {
        results.errors.push({ row: row.rowNumber, name: row.name, message: err.message });
      }
    }

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'IMPORT', entity: 'Product',
      description: `Imported products: ${results.inserted} inserted, ${results.skipped} skipped, ${results.errors.length} errors`,
      newValue: results, ...clientInfo,
    });

    ApiResponse.success(res, results, 'Import completed');
  } catch (error) {
    next(error);
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
