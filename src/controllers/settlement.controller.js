const fs = require('fs');
const mongoose = require('mongoose');
const Settlement = require('../models/settlement.model');
const Replacement = require('../models/replacement.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { pagination: paginationConfig } = require('../configs/app.config');
const { isReplicaSet } = require('../configs/db.config');
const { applyCompanyScope, assertCompanyAccess } = require('../utils/companyAccess');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { calculateSettlement, normalizeProductRows: normalizeSettlementProductRows } = require('../services/settlementCalculation.service');
const { ensureSettlementForReplacement } = require('../services/settlementLifecycle.service');
const { validateActiveProductSelections } = require('../utils/productSelection');
const {
  createTempSettlementPdfPath,
  ensureSettlementDirectories,
  fileExists,
  getSettlementPdfInfo,
  removeFileIfExists,
  renderSettlementPdf,
  uploadSettlementPdfToCloudinary,
} = require('../services/settlementPdf.service');

const populateSettlement = (query) => query
  .populate({
    path: 'replacementId',
    populate: [
      { path: 'receivingTransport', select: 'name contact' },
      { path: 'dispatchTransport', select: 'name contact' },
      { path: 'masterCartonId', select: 'cartonNumber entries status' },
    ],
  })
  .populate('invoiceId', 'invoiceNumber invoiceDate lrNo transportName dispatchDate')
  .populate('partyId', 'name town gst mobile address')
  .populate('companyId', 'name address gst contact email')
  .populate('createdBy', 'username role')
  .populate('completedBy', 'username role');

// Lightweight populate for list views (fewer fields = faster)
const populateSettlementList = (query) => query
  .populate({
    path: 'replacementId',
    select: 'replacementId approvalDate sentDate town receivingDate',
  })
  .populate('partyId', 'name town')
  .populate('companyId', 'name')
  .select('settlementNo replacementId partyId companyId approvalType approvedValue sentValue difference settlementStatus approvedProducts companyRLNo cnNo lastSaleInvoiceNo isLocked createdAt');

const normalizeProductRows = async (rows = [], req, companyId) => {
  const selectedRows = await validateActiveProductSelections({
    rows,
    user: req.user,
    companyId,
    label: 'Sent product',
  });
  return normalizeSettlementProductRows(selectedRows);
};

const isSuperAdmin = (req) => req.user?.role === 'super_admin';

const assertEditableSettlement = (req, settlement) => {
  if (settlement.isLocked) throw ApiError.forbidden('Settlement is locked. Super Admin must unlock it before corrections.');
};

const findSettlementById = async (req, id) => {
  const settlement = await populateSettlement(Settlement.findById(id));
  if (!settlement) throw ApiError.notFound('Settlement not found');
  assertCompanyAccess(req.user, settlement.companyId?._id || settlement.companyId);
  return settlement;
};

const hasProductMismatch = (settlement) => (
  (settlement.productMappings || []).some((row) => !['EXACT_MATCH', 'SUBSTITUTED'].includes(row.mappingStatus))
);

const applySettlementPayload = async (req, settlement, body = {}) => {
  if (body.lastSaleInvoiceNo !== undefined) settlement.lastSaleInvoiceNo = body.lastSaleInvoiceNo;
  if (body.sentProducts !== undefined) settlement.sentProducts = await normalizeProductRows(body.sentProducts, req, settlement.companyId);
  if (body.remarks !== undefined) settlement.remarks = body.remarks;
};

const createSettlementPdf = async (settlement) => {
  await ensureSettlementDirectories();
  const pdfInfo = getSettlementPdfInfo(settlement.settlementNo);
  const tempPdfPath = createTempSettlementPdfPath(settlement.settlementNo);
  const backupPath = pdfInfo.absolutePath + '.backup-' + Date.now();
  const hadExistingPdf = await fileExists(pdfInfo.absolutePath);

  try {
    await renderSettlementPdf(settlement.toObject ? settlement.toObject() : settlement, tempPdfPath);
    if (hadExistingPdf) await fs.promises.rename(pdfInfo.absolutePath, backupPath);
    await fs.promises.rename(tempPdfPath, pdfInfo.absolutePath);
    if (hadExistingPdf) await removeFileIfExists(backupPath);
    const cloudinaryUrl = await uploadSettlementPdfToCloudinary(pdfInfo.absolutePath, settlement.settlementNo);
    return { ...pdfInfo, publicPath: cloudinaryUrl || pdfInfo.publicPath };
  } catch (error) {
    await removeFileIfExists(tempPdfPath).catch(() => {});
    await removeFileIfExists(pdfInfo.absolutePath).catch(() => {});
    if (hadExistingPdf && await fileExists(backupPath)) await fs.promises.rename(backupPath, pdfInfo.absolutePath).catch(() => {});
    throw error;
  }
};

const getSettlements = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || paginationConfig.defaultPage, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || paginationConfig.defaultLimit, 1), paginationConfig.maxLimit);
    const skip = (page - 1) * limit;
    const filter = {};

    if (req.query.company || req.query.companyId) filter.companyId = req.query.company || req.query.companyId;
    applyCompanyScope(filter, req.user, 'companyId');
    if (req.query.party || req.query.partyId) filter.partyId = req.query.party || req.query.partyId;
    if (req.query.settlementStatus) filter.settlementStatus = req.query.settlementStatus;
    if (req.query.approvalType) filter.approvalType = req.query.approvalType;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.createdAt.$lte = new Date(req.query.dateTo + 'T23:59:59');
    }
    if (req.query.search) {
      filter.$or = [
        { settlementNo: { $regex: req.query.search, $options: 'i' } },
        { lastSaleInvoiceNo: { $regex: req.query.search, $options: 'i' } },
        { companyRLNo: { $regex: req.query.search, $options: 'i' } },
        { cnNo: { $regex: req.query.search, $options: 'i' } },
      ];
    }

    const [settlements, total] = await Promise.all([
      populateSettlementList(Settlement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)).lean(),
      Settlement.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, settlements, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
};

const getPendingSettlements = async (req, res, next) => {
  try {
    const filter = { settlementStatus: { $nin: ['SETTLED', 'REJECTED'] } };
    if (req.query.company || req.query.companyId) filter.companyId = req.query.company || req.query.companyId;
    applyCompanyScope(filter, req.user, 'companyId');
    if (req.query.party || req.query.partyId) filter.partyId = req.query.party || req.query.partyId;
    if (req.query.approvalType) filter.approvalType = req.query.approvalType;

    const settlements = await populateSettlementList(Settlement.find(filter).sort({ createdAt: -1 }).limit(200)).lean();
    ApiResponse.success(res, settlements);
  } catch (error) {
    next(error);
  }
};

const getSettlement = async (req, res, next) => {
  try {
    ApiResponse.success(res, await findSettlementById(req, req.params.id));
  } catch (error) {
    next(error);
  }
};

const createSettlement = async (req, res, next) => {
  try {
    const replacement = await Replacement.findById(req.body.replacementId);
    if (!replacement) throw ApiError.notFound('Replacement not found');
    assertCompanyAccess(req.user, replacement.company);
    if (replacement.approvalStatus !== 'Approved') throw ApiError.badRequest('Company approval must be completed before settlement.');

    let settlement = await ensureSettlementForReplacement(replacement, req.user.id);
    assertEditableSettlement(req, settlement);
    const oldValue = settlement.toObject();

    await applySettlementPayload(req, settlement, req.body);
    await settlement.save();

    settlement = await populateSettlement(Settlement.findById(settlement._id));
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'SETTLEMENT_CREATED',
      entity: 'Settlement',
      entityId: settlement._id,
      description: `Created settlement ${settlement.settlementNo}`,
      oldValue,
      newValue: settlement.toObject(),
      ...clientInfo,
    });

    ApiResponse.created(res, settlement, 'Settlement created successfully');
  } catch (error) {
    next(error);
  }
};

const updateSettlement = async (req, res, next) => {
  try {
    const settlement = await Settlement.findById(req.params.id);
    if (!settlement) throw ApiError.notFound('Settlement not found');
    assertCompanyAccess(req.user, settlement.companyId);
    assertEditableSettlement(req, settlement);
    const oldValue = settlement.toObject();

    await applySettlementPayload(req, settlement, req.body);
    if (req.body.settlementStatus && ['PENDING', 'PARTIAL', 'MATCHED', 'ON_HOLD'].includes(req.body.settlementStatus)) {
      settlement.settlementStatus = req.body.settlementStatus;
    }
    await settlement.save();

    const populated = await populateSettlement(Settlement.findById(settlement._id));
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'SETTLEMENT_EDITED',
      entity: 'Settlement',
      entityId: settlement._id,
      description: `Edited settlement ${settlement.settlementNo}`,
      oldValue,
      newValue: settlement.toObject(),
      ...clientInfo,
    });
    ApiResponse.success(res, populated, 'Settlement updated');
  } catch (error) {
    next(error);
  }
};

const calculateSettlementPreview = async (req, res, next) => {
  try {
    const settlement = await Settlement.findById(req.params.id);
    if (!settlement) throw ApiError.notFound('Settlement not found');
    assertCompanyAccess(req.user, settlement.companyId);

    const preview = settlement.toObject();
    if (req.body.lastSaleInvoiceNo !== undefined) preview.lastSaleInvoiceNo = req.body.lastSaleInvoiceNo;
    if (req.body.sentProducts !== undefined) preview.sentProducts = await normalizeProductRows(req.body.sentProducts, req, settlement.companyId);
    if (req.body.remarks !== undefined) preview.remarks = req.body.remarks;

    const calculated = calculateSettlement(preview);
    ApiResponse.success(res, {
      ...preview,
      ...calculated,
    }, 'Settlement calculated');
  } catch (error) {
    next(error);
  }
};

const completeSettlement = async (req, res, next) => {
  const session = await mongoose.startSession();
  const useTransaction = isReplicaSet();
  let settlementId = null;

  try {
    if (useTransaction) session.startTransaction();

    let settlement = await Settlement.findById(req.params.id).session(useTransaction ? session : null);
    if (!settlement) throw ApiError.notFound('Settlement not found');
    assertCompanyAccess(req.user, settlement.companyId);
    assertEditableSettlement(req, settlement);

    const replacement = await Replacement.findById(settlement.replacementId).session(useTransaction ? session : null);
    if (!replacement) throw ApiError.notFound('Replacement not found');
    assertCompanyAccess(req.user, replacement.company);
    if (replacement.approvalStatus !== 'Approved') throw ApiError.badRequest('Company approval must be completed before settlement.');
    if (!replacement.isDispatchLocked) throw ApiError.badRequest('Dispatch must be locked after approval before settlement can be completed.');

    const oldValue = settlement.toObject();
    await applySettlementPayload(req, settlement, req.body);
    await settlement.save(useTransaction ? { session } : undefined);

    if (!settlement.lastSaleInvoiceNo) throw ApiError.badRequest('Last sale invoice number is mandatory.');
    if (!settlement.sentProducts.length) throw ApiError.badRequest('At least one sent product is required.');
    if (settlement.difference !== 0 && !req.body.confirmMismatch && !isSuperAdmin(req)) {
      throw ApiError.badRequest('Settlement values do not match. Confirm mismatch or ask Super Admin to approve correction.');
    }
    if (hasProductMismatch(settlement) && !req.body.confirmMismatch && !isSuperAdmin(req)) {
      throw ApiError.badRequest('Product approval mismatch detected. Confirm mismatch or ask Super Admin to approve correction.');
    }

    settlement.settlementStatus = 'SETTLED';
    settlement.settlementDate = req.body.settlementDate || new Date();
    settlement.completedAt = new Date();
    settlement.completedBy = req.user.id;
    settlement.isLocked = true;
    settlement.lockedAt = new Date();
    await settlement.save(useTransaction ? { session } : undefined);

    settlement = await populateSettlement(Settlement.findById(settlement._id)).session(useTransaction ? session : null);
    const pdfInfo = await createSettlementPdf(settlement);
    settlement.pdfPath = pdfInfo.publicPath;
    settlement.pdfGeneratedAt = new Date();
    await settlement.save(useTransaction ? { session } : undefined);

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'SETTLEMENT_COMPLETED',
      entity: 'Settlement',
      entityId: settlement._id,
      description: `Completed settlement ${settlement.settlementNo}`,
      oldValue,
      newValue: settlement.toObject(),
      session: useTransaction ? session : null,
      ...clientInfo,
    });
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'SETTLEMENT_PDF_GENERATED',
      entity: 'Settlement',
      entityId: settlement._id,
      description: `Generated settlement PDF ${settlement.settlementNo}`,
      newValue: { pdfPath: settlement.pdfPath },
      session: useTransaction ? session : null,
      ...clientInfo,
    });

    settlementId = settlement._id;
    if (useTransaction) await session.commitTransaction();

    const completedSettlement = await populateSettlement(Settlement.findById(settlementId));
    ApiResponse.success(res, completedSettlement, 'Settlement completed');
  } catch (error) {
    if (useTransaction) await session.abortTransaction().catch(() => {});
    next(error);
  } finally {
    await session.endSession();
  }
};

const cancelSettlement = async (req, res, next) => {
  try {
    const settlement = await Settlement.findById(req.params.id);
    if (!settlement) throw ApiError.notFound('Settlement not found');
    assertCompanyAccess(req.user, settlement.companyId);
    const oldValue = settlement.toObject();

    settlement.settlementStatus = 'REJECTED';
    settlement.remarks = req.body.reason || settlement.remarks || 'Cancelled by Super Admin';
    settlement.cancelledAt = new Date();
    settlement.cancelledBy = req.user.id;
    settlement.isLocked = true;
    settlement.lockedAt = settlement.lockedAt || new Date();
    await settlement.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'SETTLEMENT_CANCELLED',
      entity: 'Settlement',
      entityId: settlement._id,
      description: `Cancelled settlement ${settlement.settlementNo}`,
      oldValue,
      newValue: settlement.toObject(),
      ...clientInfo,
    });
    ApiResponse.success(res, settlement, 'Settlement cancelled');
  } catch (error) {
    next(error);
  }
};

const unlockSettlement = async (req, res, next) => {
  try {
    const settlement = await Settlement.findById(req.params.id);
    if (!settlement) throw ApiError.notFound('Settlement not found');
    assertCompanyAccess(req.user, settlement.companyId);
    const oldValue = { isLocked: settlement.isLocked, settlementStatus: settlement.settlementStatus };
    settlement.isLocked = false;
    settlement.unlockedBy = req.user.id;
    settlement.remarks = req.body.reason || settlement.remarks || 'Unlocked by Super Admin';
    if (settlement.settlementStatus === 'SETTLED') settlement.settlementStatus = 'ON_HOLD';
    await settlement.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'SETTLEMENT_UNLOCKED',
      entity: 'Settlement',
      entityId: settlement._id,
      description: `Unlocked settlement ${settlement.settlementNo}`,
      oldValue,
      newValue: { isLocked: settlement.isLocked, settlementStatus: settlement.settlementStatus, reason: req.body.reason || '' },
      ...clientInfo,
    });
    ApiResponse.success(res, settlement, 'Settlement unlocked');
  } catch (error) {
    next(error);
  }
};

const getSettlementPDF = async (req, res, next) => {
  try {
    let settlement = await findSettlementById(req, req.params.id);
    const pdfInfo = getSettlementPdfInfo(settlement.settlementNo);
    if (!settlement.pdfPath || !await fileExists(pdfInfo.absolutePath)) {
      const generated = await createSettlementPdf(settlement);
      settlement.pdfPath = generated.publicPath;
      settlement.pdfGeneratedAt = new Date();
      await settlement.save();
      const clientInfo = getClientInfo(req);
      await createAuditLog({
        userId: req.user.id,
        username: req.user.username,
        action: 'SETTLEMENT_PDF_GENERATED',
        entity: 'Settlement',
        entityId: settlement._id,
        description: `Generated settlement PDF ${settlement.settlementNo}`,
        newValue: { pdfPath: settlement.pdfPath },
        ...clientInfo,
      });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + pdfInfo.fileName + '"');
    res.sendFile(pdfInfo.absolutePath, (error) => { if (error) next(error); });
  } catch (error) {
    next(error);
  }
};

const getPartySettlements = async (req, res, next) => {
  try {
    const filter = { partyId: req.params.partyId };
    applyCompanyScope(filter, req.user, 'companyId');
    const settlements = await populateSettlement(Settlement.find(filter).sort({ createdAt: -1 }));
    const summary = {
      totalReplacements: settlements.length,
      totalApproved: settlements.reduce((sum, settlement) => sum + Number(settlement.approvedValue || 0), 0),
      totalSettled: settlements.filter((settlement) => settlement.settlementStatus === 'SETTLED').reduce((sum, settlement) => sum + Number(settlement.sentValue || 0), 0),
      totalPending: settlements.filter((settlement) => !['SETTLED', 'REJECTED'].includes(settlement.settlementStatus)).length,
      lastSaleInvoice: settlements.find((settlement) => settlement.lastSaleInvoiceNo)?.lastSaleInvoiceNo || '',
      lastReplacement: settlements[0]?.replacementId?.replacementId || '',
      lastSettlement: settlements.find((settlement) => settlement.settlementStatus === 'SETTLED')?.settlementNo || '',
    };
    ApiResponse.success(res, { summary, settlements });
  } catch (error) {
    next(error);
  }
};

const getCompanySettlements = async (req, res, next) => {
  try {
    assertCompanyAccess(req.user, req.params.companyId);
    const settlements = await populateSettlement(Settlement.find({ companyId: req.params.companyId }).sort({ createdAt: -1 }));
    ApiResponse.success(res, settlements);
  } catch (error) {
    next(error);
  }
};

const getSettlementDashboard = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const base = {};
    applyCompanyScope(base, req.user, 'companyId');
    if (req.query.company || req.query.companyId) {
      assertCompanyAccess(req.user, req.query.company || req.query.companyId);
      base.companyId = req.query.company || req.query.companyId;
    }
    if (req.query.party || req.query.partyId) base.partyId = req.query.party || req.query.partyId;
    if (req.query.settlementStatus) base.settlementStatus = req.query.settlementStatus;
    if (req.query.approvalType) base.approvalType = req.query.approvalType;

    const withBase = (extra) => ({ ...base, ...extra });
    const [
      pending,
      todayCompleted,
      completed,
      partial,
      onHold,
      approvedAgg,
      settledAgg,
      pendingAgg,
    ] = await Promise.all([
      Settlement.countDocuments(withBase({ settlementStatus: { $nin: ['SETTLED', 'REJECTED'] } })),
      Settlement.countDocuments(withBase({ completedAt: { $gte: today, $lt: tomorrow } })),
      Settlement.countDocuments(withBase({ settlementStatus: 'SETTLED' })),
      Settlement.countDocuments(withBase({ settlementStatus: 'PARTIAL' })),
      Settlement.countDocuments(withBase({ settlementStatus: 'ON_HOLD' })),
      Settlement.aggregate([{ $match: base }, { $group: { _id: null, total: { $sum: '$approvedValue' } } }]),
      Settlement.aggregate([{ $match: withBase({ settlementStatus: 'SETTLED' }) }, { $group: { _id: null, total: { $sum: '$sentValue' } } }]),
      Settlement.aggregate([{ $match: withBase({ settlementStatus: { $nin: ['SETTLED', 'REJECTED'] } }) }, { $group: { _id: null, total: { $sum: '$approvedValue' } } }]),
    ]);

    ApiResponse.success(res, {
      settlementPending: pending,
      settlementToday: todayCompleted,
      settlementCompleted: completed,
      partialSettlement: partial,
      onHold,
      totalApprovedValue: approvedAgg[0]?.total || 0,
      totalSettledValue: settledAgg[0]?.total || 0,
      pendingSettlementValue: pendingAgg[0]?.total || 0,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  calculateSettlementPreview,
  cancelSettlement,
  completeSettlement,
  createSettlement,
  getCompanySettlements,
  getPartySettlements,
  getPendingSettlements,
  getSettlement,
  getSettlementDashboard,
  getSettlementPDF,
  getSettlements,
  unlockSettlement,
  updateSettlement,
};
