const Party = require('../models/party.model');
const Replacement = require('../models/replacement.model');
const Settlement = require('../models/settlement.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');
const { applyCompanyScope, assertCompanyAccess } = require('../utils/companyAccess');
const ExcelJS = require('exceljs');
const path = require('path');

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildReplacementFilter = (req, partyId = null) => {
  const filter = { status: 'active' };
  if (partyId) filter.party = partyId;
  if (req.query.companyId) filter.company = req.query.companyId;
  if (req.query.company) filter.company = req.query.company;
  applyCompanyScope(filter, req.user, 'company');

  if (req.query.approvalStatus) filter.approvalStatus = req.query.approvalStatus;
  if (req.query.replacementId) filter.replacementId = { $regex: req.query.replacementId, $options: 'i' };
  if (req.query.invoiceNumber) filter.invoiceNumber = { $regex: req.query.invoiceNumber, $options: 'i' };
  if (req.query.lrNumber) {
    filter.$or = [
      { receivingLRNo: { $regex: req.query.lrNumber, $options: 'i' } },
      { dispatchLRNo: { $regex: req.query.lrNumber, $options: 'i' } },
    ];
  }
  if (req.query.quickSearch) {
    filter.$or = [
      { replacementId: { $regex: req.query.quickSearch, $options: 'i' } },
      { invoiceNumber: { $regex: req.query.quickSearch, $options: 'i' } },
      { receivingLRNo: { $regex: req.query.quickSearch, $options: 'i' } },
      { dispatchLRNo: { $regex: req.query.quickSearch, $options: 'i' } },
    ];
  }
  if (req.query.receivedDateFrom || req.query.receivedDateTo) {
    filter.receivingDate = {};
    if (req.query.receivedDateFrom) filter.receivingDate.$gte = new Date(req.query.receivedDateFrom);
    if (req.query.receivedDateTo) filter.receivingDate.$lte = new Date(req.query.receivedDateTo + 'T23:59:59');
  }
  if (req.query.sentDateFrom || req.query.sentDateTo) {
    filter.sentDate = {};
    if (req.query.sentDateFrom) filter.sentDate.$gte = new Date(req.query.sentDateFrom);
    if (req.query.sentDateTo) filter.sentDate.$lte = new Date(req.query.sentDateTo + 'T23:59:59');
  }
  if (req.query.replacementStatus === 'RECEIVED') filter.sentDate = null;
  if (req.query.replacementStatus === 'SENT') filter.sentDate = { $ne: null };
  if (req.query.replacementStatus === 'PENDING') filter.approvalStatus = 'Pending';
  if (req.query.replacementStatus === 'APPROVED') filter.approvalStatus = 'Approved';
  if (req.query.replacementStatus === 'REJECTED') filter.approvalStatus = 'Rejected';

  return filter;
};

const getReplacementApprovedValue = (replacement) => (
  replacement.approvalType === 'Product'
    ? Number(replacement.totalProductApprovalValue || replacement.approvalAmount || 0)
    : Number(replacement.approvalAmount || 0)
);

const summarizeReplacementRows = (replacements, settlementByReplacement) => replacements.reduce((summary, replacement) => {
  const settlement = settlementByReplacement.get(String(replacement._id));
  const settlementStatus = settlement?.settlementStatus || '';
  const approvedValue = Number(settlement?.approvedValue ?? getReplacementApprovedValue(replacement));
  const sentValue = Number(settlement?.sentValue || 0);

  summary.totalReplacements += 1;
  summary.received += 1;
  if (replacement.sentDate) summary.sent += 1;
  if (replacement.approvalStatus === 'Pending') summary.pendingApproval += 1;
  if (replacement.approvalStatus === 'Approved') summary.approved += 1;
  if (replacement.approvalStatus === 'Rejected') summary.rejected += 1;
  if (settlementStatus && !['SETTLED', 'REJECTED'].includes(settlementStatus)) summary.settlementPending += 1;
  if (settlementStatus === 'SETTLED') summary.settled += 1;
  summary.totalCases += Number(replacement.receivingCases || 0);
  summary.totalReceivedCases += Number(replacement.receivingCases || 0);
  summary.totalSentCases += Number(replacement.dispatchCases || 0);
  summary.approvedAmount += approvedValue;
  if (settlementStatus === 'SETTLED') summary.settledAmount += sentValue;
  if (settlementStatus && !['SETTLED', 'REJECTED'].includes(settlementStatus)) summary.pendingSettlementAmount += approvedValue;
  if (!summary.lastReplacementDate || new Date(replacement.receivingDate) > new Date(summary.lastReplacementDate)) {
    summary.lastReplacementDate = replacement.receivingDate;
  }
  return summary;
}, {
  totalReplacements: 0,
  received: 0,
  sent: 0,
  pendingApproval: 0,
  approved: 0,
  settlementPending: 0,
  settled: 0,
  rejected: 0,
  totalCases: 0,
  totalReceivedCases: 0,
  totalSentCases: 0,
  approvedAmount: 0,
  settledAmount: 0,
  pendingSettlementAmount: 0,
  lastReplacementDate: null,
});

// GET /api/parties
const getParties = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || paginationConfig.defaultPage;
    const limit = Math.min(parseInt(req.query.limit) || paginationConfig.defaultLimit, paginationConfig.maxLimit);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.town) filter.town = { $regex: req.query.town, $options: 'i' };
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { town: { $regex: req.query.search, $options: 'i' } },
        { gst: { $regex: req.query.search, $options: 'i' } },
        { mobile: { $regex: req.query.search, $options: 'i' } },
      ];
    }

    const [parties, total] = await Promise.all([
      Party.find(filter).populate('transport', 'name').sort({ name: 1 }).skip(skip).limit(limit),
      Party.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, parties, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
};

// GET /api/parties/all - For dropdowns
const getAllParties = async (req, res, next) => {
  try {
    const filter = { status: 'active' };
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: 'i' };
    }
    const parties = await Party.find(filter).sort({ name: 1 }).select('name town gst').limit(50);
    ApiResponse.success(res, parties);
  } catch (error) {
    next(error);
  }
};

// GET /api/parties/:id
const getParty = async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id).populate('transport', 'name contact');
    if (!party) throw ApiError.notFound('Party not found');
    ApiResponse.success(res, party);
  } catch (error) {
    next(error);
  }
};

// GET /api/search/parties
const searchReplacementParties = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || paginationConfig.defaultPage;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const filter = buildReplacementFilter(req);
    const replacements = await Replacement.find(filter)
      .select('party company receivingDate receivingCases sentDate dispatchCases approvalStatus approvalType approvalAmount totalProductApprovalValue')
      .populate('party', 'name town status')
      .lean();

    const replacementIds = replacements.map((replacement) => replacement._id);
    const settlementFilter = { replacementId: { $in: replacementIds } };
    if (req.query.settlementStatus) settlementFilter.settlementStatus = req.query.settlementStatus;
    if (req.query.lastSaleInvoiceNumber) settlementFilter.lastSaleInvoiceNo = { $regex: req.query.lastSaleInvoiceNumber, $options: 'i' };

    const settlements = await Settlement.find(settlementFilter)
      .select('replacementId settlementStatus approvedValue sentValue lastSaleInvoiceNo')
      .lean();
    const settlementByReplacement = new Map(settlements.map((settlement) => [String(settlement.replacementId), settlement]));

    const partyNameRegex = req.query.partyName ? new RegExp(escapeRegExp(req.query.partyName), 'i') : null;
    const townRegex = req.query.town ? new RegExp(escapeRegExp(req.query.town), 'i') : null;
    const rowsByParty = new Map();

    replacements.forEach((replacement) => {
      const party = replacement.party;
      if (!party || party.status === 'inactive') return;
      if (partyNameRegex && !partyNameRegex.test(party.name || '')) return;
      if (townRegex && !townRegex.test(party.town || '')) return;
      if ((req.query.settlementStatus || req.query.lastSaleInvoiceNumber) && !settlementByReplacement.has(String(replacement._id))) return;

      const key = String(party._id);
      const row = rowsByParty.get(key) || { party: { _id: party._id, name: party.name, town: party.town }, replacements: [] };
      row.replacements.push(replacement);
      rowsByParty.set(key, row);
    });

    const allRows = [...rowsByParty.values()]
      .map((row) => ({
        ...row.party,
        summary: summarizeReplacementRows(row.replacements, settlementByReplacement),
      }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    ApiResponse.paginated(res, allRows.slice(skip, skip + limit), {
      page,
      limit,
      total: allRows.length,
      pages: Math.ceil(allRows.length / limit),
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/parties/:id/replacement-summary
const getPartyReplacementSummary = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || paginationConfig.defaultPage;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const party = await Party.findById(req.params.id).select('name town gst mobile address route').lean();
    if (!party) throw ApiError.notFound('Party not found');

    const filter = buildReplacementFilter(req, req.params.id);
    const replacements = await Replacement.find(filter)
      .select('replacementId company party town receivingDate receivingCases sentDate dispatchCases invoiceNumber approvalStatus approvalType approvalAmount totalProductApprovalValue approvalDate companyRLNo cnNo masterCartonId createdAt')
      .populate('company', 'name')
      .populate('masterCartonId', 'cartonNumber totalCases status')
      .sort({ receivingDate: -1, createdAt: -1 })
      .lean();

    if (req.query.companyId || req.query.company) assertCompanyAccess(req.user, req.query.companyId || req.query.company);

    const replacementIds = replacements.map((replacement) => replacement._id);
    const settlementFilter = { replacementId: { $in: replacementIds } };
    if (req.query.settlementStatus) settlementFilter.settlementStatus = req.query.settlementStatus;
    if (req.query.lastSaleInvoiceNumber) settlementFilter.lastSaleInvoiceNo = { $regex: req.query.lastSaleInvoiceNumber, $options: 'i' };

    const settlements = await Settlement.find(settlementFilter)
      .select('replacementId settlementNo settlementStatus approvedValue sentValue difference lastSaleInvoiceNo settlementDate')
      .lean();
    const settlementByReplacement = new Map(settlements.map((settlement) => [String(settlement.replacementId), settlement]));

    const filteredReplacements = (req.query.settlementStatus || req.query.lastSaleInvoiceNumber)
      ? replacements.filter((replacement) => settlementByReplacement.has(String(replacement._id)))
      : replacements;
    const summary = summarizeReplacementRows(replacements, settlementByReplacement);
    const history = filteredReplacements.slice(skip, skip + limit).map((replacement) => {
      const settlement = settlementByReplacement.get(String(replacement._id)) || null;
      return {
        _id: replacement._id,
        replacementId: replacement.replacementId,
        company: replacement.company,
        party: { _id: party._id, name: party.name, town: party.town },
        town: replacement.town || party.town,
        receivedDate: replacement.receivingDate,
        receivedCases: replacement.receivingCases,
        sentDate: replacement.sentDate,
        sentCases: replacement.dispatchCases,
        invoiceNo: replacement.invoiceNumber,
        approvalStatus: replacement.approvalStatus,
        approvalAmount: getReplacementApprovedValue(replacement),
        settlementStatus: settlement?.settlementStatus || '',
        settlementNo: settlement?.settlementNo || '',
        settlementAmount: settlement?.approvedValue || 0,
        lastSaleInvoiceNo: settlement?.lastSaleInvoiceNo || '',
        settlement,
      };
    });

    ApiResponse.success(res, {
      party,
      summary,
      replacementHistory: history,
      settlementSummary: {
        settlementPending: summary.settlementPending,
        settled: summary.settled,
        settledAmount: summary.settledAmount,
        pendingSettlementAmount: summary.pendingSettlementAmount,
      },
      pagination: {
        page,
        limit,
        total: filteredReplacements.length,
        pages: Math.ceil(filteredReplacements.length / limit),
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/parties
const createParty = async (req, res, next) => {
  try {
    const { name, town, gst, mobile, address, route, transport } = req.body;

    // Duplicate check
    const existing = await Party.findOne({
      name: { $regex: `^${name.trim()}$`, $options: 'i' },
      town: { $regex: `^${(town || '').trim()}$`, $options: 'i' },
    });
    if (existing) throw ApiError.conflict(`Party "${name}" in "${town}" already exists`);

    const party = await Party.create({ name, town, gst, mobile, address, route, transport: transport || null });

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'CREATE', entity: 'Party', entityId: party._id,
      description: `Created party: ${name}, ${town}`,
      newValue: { name, town, gst, mobile }, ...clientInfo,
    });

    ApiResponse.created(res, party, 'Party created successfully');
  } catch (error) {
    next(error);
  }
};

// PUT /api/parties/:id
const updateParty = async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) throw ApiError.notFound('Party not found');

    const oldValue = party.toObject();
    const { name, town, gst, mobile, address, route, transport, status } = req.body;

    if (name !== undefined) party.name = name;
    if (town !== undefined) party.town = town;
    if (gst !== undefined) party.gst = gst;
    if (mobile !== undefined) party.mobile = mobile;
    if (address !== undefined) party.address = address;
    if (route !== undefined) party.route = route;
    if (transport !== undefined) party.transport = transport || null;
    if (status !== undefined) party.status = status;

    await party.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'UPDATE', entity: 'Party', entityId: party._id,
      description: `Updated party: ${party.name}`,
      oldValue, newValue: party.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, party, 'Party updated successfully');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/parties/:id
const deleteParty = async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) throw ApiError.notFound('Party not found');

    await Party.findByIdAndDelete(req.params.id);

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'DELETE', entity: 'Party', entityId: party._id,
      description: `Deleted party: ${party.name}`,
      oldValue: party.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, null, 'Party deleted successfully');
  } catch (error) {
    next(error);
  }
};

// GET /api/parties/sample-excel
const downloadSampleExcel = async (req, res, next) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Parties');

    sheet.columns = [
      { header: 'Party Name *', key: 'name', width: 30 },
      { header: 'Town', key: 'town', width: 20 },
      { header: 'GST', key: 'gst', width: 20 },
      { header: 'Mobile', key: 'mobile', width: 15 },
      { header: 'Address', key: 'address', width: 40 },
      { header: 'Route', key: 'route', width: 20 },
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true, size: 12 };
    sheet.getRow(1).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1B2A' },
    };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

    // Add sample rows
    sheet.addRow({ name: 'ABC Trading Co.', town: 'Ahmedabad', gst: '24AAAAA0000A1Z5', mobile: '9876543210', address: '123, Market Road', route: 'Route 1' });
    sheet.addRow({ name: 'XYZ Distributors', town: 'Surat', gst: '24BBBBB0000B1Z5', mobile: '9876543211', address: '456, Station Road', route: 'Route 2' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=party_sample.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

// POST /api/parties/import
const importParties = async (req, res, next) => {
  try {
    if (!req.file) throw ApiError.badRequest('Excel file is required');

    const strategy = req.body.strategy || 'skip'; // 'skip' | 'update'
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    
    const sheet = workbook.getWorksheet(1);

    if (!sheet) throw ApiError.badRequest('No worksheet found in the Excel file');

    const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };
    const rows = [];

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      const name = row.getCell(1).value?.toString()?.trim();
      const town = row.getCell(2).value?.toString()?.trim() || '';
      const gst = row.getCell(3).value?.toString()?.trim() || '';
      const mobile = row.getCell(4).value?.toString()?.trim() || '';
      const address = row.getCell(5).value?.toString()?.trim() || '';
      const route = row.getCell(6).value?.toString()?.trim() || '';

      if (!name) {
        results.errors.push({ row: rowNumber, message: 'Party name is required' });
        return;
      }

      rows.push({ rowNumber, name, town, gst, mobile, address, route });
    });

    for (const row of rows) {
      try {
        const existing = await Party.findOne({
          name: { $regex: `^${row.name}$`, $options: 'i' },
          town: { $regex: `^${row.town}$`, $options: 'i' },
        });

        if (existing) {
          if (strategy === 'update') {
            existing.gst = row.gst || existing.gst;
            existing.mobile = row.mobile || existing.mobile;
            existing.address = row.address || existing.address;
            existing.route = row.route || existing.route;
            await existing.save();
            results.updated++;
          } else {
            results.skipped++;
          }
        } else {
          await Party.create({
            name: row.name, town: row.town, gst: row.gst,
            mobile: row.mobile, address: row.address, route: row.route,
          });
          results.inserted++;
        }
      } catch (err) {
        results.errors.push({ row: row.rowNumber, message: err.message });
      }
    }

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'IMPORT', entity: 'Party',
      description: `Imported parties: ${results.inserted} inserted, ${results.updated} updated, ${results.skipped} skipped, ${results.errors.length} errors`,
      newValue: results, ...clientInfo,
    });

    ApiResponse.success(res, results, 'Import completed');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getParties, getAllParties, getParty, searchReplacementParties, getPartyReplacementSummary, createParty, updateParty, deleteParty,
  downloadSampleExcel, importParties,
};
