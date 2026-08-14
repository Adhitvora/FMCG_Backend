const Replacement = require('../models/replacement.model');
const Party = require('../models/party.model');
const Counter = require('../models/counter.model');
const Settlement = require('../models/settlement.model');
const AuditLog = require('../models/auditLog.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');
const { applyCompanyScope, assertCompanyAccess } = require('../utils/companyAccess');
const { ensureSettlementForReplacement } = require('../services/settlementLifecycle.service');

// Generate replacement ID: REP-20260802-00001
const generateReplacementId = async () => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = await Counter.getNextSequence(`rep_${dateStr}`);
  return `REP-${dateStr}-${String(seq).padStart(5, '0')}`;
};

// GET /api/replacements
const getReplacements = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || paginationConfig.defaultPage;
    const limit = Math.min(parseInt(req.query.limit) || paginationConfig.defaultLimit, paginationConfig.maxLimit);
    const skip = (page - 1) * limit;

    const filter = { status: 'active' };
    if (req.query.company) filter.company = req.query.company;
    applyCompanyScope(filter, req.user, 'company');
    if (req.query.party) filter.party = req.query.party;
    if (req.query.approvalStatus) filter.approvalStatus = req.query.approvalStatus;
    if (req.query.town) filter.town = { $regex: req.query.town, $options: 'i' };
    if (req.query.dateFrom || req.query.dateTo) {
      filter.receivingDate = {};
      if (req.query.dateFrom) filter.receivingDate.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.receivingDate.$lte = new Date(req.query.dateTo + 'T23:59:59');
    }
    if (req.query.invoiceStatus === 'pending') filter.invoiceId = null;
    if (req.query.invoiceStatus === 'generated') filter.invoiceId = { $ne: null };
    if (req.query.dispatchStatus === 'pending') filter.sentDate = null;
    if (req.query.dispatchStatus === 'dispatched') filter.sentDate = { $ne: null };
    if (req.query.search) {
      filter.$or = [
        { replacementId: { $regex: req.query.search, $options: 'i' } },
        { town: { $regex: req.query.search, $options: 'i' } },
        { receivingLRNo: { $regex: req.query.search, $options: 'i' } },
        { dispatchLRNo: { $regex: req.query.search, $options: 'i' } },
      ];
    }

    const [replacements, total] = await Promise.all([
      Replacement.find(filter)
        .populate('company', 'name')
        .populate('party', 'name town')
        .populate('receivingTransport', 'name')
        .populate('dispatchTransport', 'name')
        .populate('masterCartonId', 'cartonNumber')
        .populate('createdBy', 'username')
        .sort({ receivingDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Replacement.countDocuments(filter),
    ]);

    const replacementIds = replacements.map((replacement) => replacement._id);
    const settlements = await Settlement.find({ replacementId: { $in: replacementIds } })
      .select('replacementId settlementNo settlementStatus approvedValue sentValue difference lastSaleInvoiceNo settlementDate pdfPath')
      .lean();
    const settlementByReplacement = new Map(settlements.map((settlement) => [String(settlement.replacementId), settlement]));
    const rows = replacements.map((replacement) => {
      const settlement = settlementByReplacement.get(String(replacement._id)) || null;
      return {
        ...replacement,
        settlementStatus: settlement?.settlementStatus || '',
        settlementNo: settlement?.settlementNo || '',
        settlement,
      };
    });

    ApiResponse.paginated(res, rows, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
};

// GET /api/replacements/:id
const getReplacement = async (req, res, next) => {
  try {
    const replacement = await Replacement.findById(req.params.id)
      .populate('company', 'name address gst')
      .populate('party', 'name town gst mobile address')
      .populate('receivingTransport', 'name contact')
      .populate('dispatchTransport', 'name contact')
      .populate('masterCartonId')
      .populate('invoiceId', 'invoiceNumber invoiceDate')
      .populate('createdBy', 'username');

    if (!replacement) throw ApiError.notFound('Replacement not found');
    assertCompanyAccess(req.user, replacement.company?._id || replacement.company);
    ApiResponse.success(res, replacement);
  } catch (error) {
    next(error);
  }
};

// GET /api/replacements/:id/360
const getReplacement360 = async (req, res, next) => {
  try {
    const replacement = await Replacement.findById(req.params.id)
      .populate('company', 'name address gst')
      .populate('party', 'name town gst mobile address route')
      .populate('receivingTransport', 'name contact')
      .populate('dispatchTransport', 'name contact')
      .populate({
        path: 'masterCartonId',
        populate: [
          { path: 'entries.party', select: 'name town' },
          { path: 'entries.replacementId', select: 'replacementId receivingCases' },
        ],
      })
      .populate('invoiceId', 'invoiceNumber invoiceDate transportName lrNo pdfPath')
      .populate('createdBy', 'username')
      .lean();

    if (!replacement) throw ApiError.notFound('Replacement not found');
    assertCompanyAccess(req.user, replacement.company?._id || replacement.company);

    const settlement = await Settlement.findOne({ replacementId: replacement._id })
      .populate('createdBy', 'username')
      .populate('completedBy', 'username')
      .lean();

    const auditEntityFilters = [
      { entity: 'Replacement', entityId: replacement._id },
    ];
    if (replacement.invoiceId?._id) auditEntityFilters.push({ entity: 'Invoice', entityId: replacement.invoiceId._id });
    if (settlement?._id) auditEntityFilters.push({ entity: 'Settlement', entityId: settlement._id });

    const audit = await AuditLog.find({ $or: auditEntityFilters })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('createdAt username action description entity')
      .lean();

    const carton = replacement.masterCartonId ? {
      cartonNumber: replacement.masterCartonId.cartonNumber,
      status: replacement.masterCartonId.status,
      totalCases: replacement.masterCartonId.totalCases,
      partiesIncluded: (replacement.masterCartonId.entries || []).map((entry) => ({
        partyName: entry.party?.name || entry.partyName || '',
        town: entry.party?.town || '',
        replacementId: entry.replacementId?.replacementId || '',
        cases: entry.cases || 0,
      })),
    } : null;

    ApiResponse.success(res, {
      replacement,
      receiving: {
        date: replacement.receivingDate,
        transport: replacement.receivingTransport,
        lrNo: replacement.receivingLRNo,
        cases: replacement.receivingCases,
        cartons: replacement.receivingCartons,
        remarks: replacement.receivingRemarks,
      },
      dispatch: {
        date: replacement.sentDate,
        transport: replacement.dispatchTransport,
        lrNo: replacement.dispatchLRNo,
        invoiceNumber: replacement.invoiceNumber || replacement.invoiceId?.invoiceNumber || '',
        cases: replacement.dispatchCases,
        cartons: replacement.dispatchCartons,
        remarks: replacement.dispatchRemarks,
      },
      invoice: replacement.invoiceId || null,
      carton,
      approval: {
        status: replacement.approvalStatus,
        type: replacement.approvalType,
        date: replacement.approvalDate,
        amount: replacement.approvalAmount,
        products: replacement.approvalProducts || [],
        companyRLNo: replacement.companyRLNo || replacement.companyReference || '',
        cnNo: replacement.cnNo || '',
        remark: replacement.approvalRemark || '',
      },
      settlement,
      documents: {
        replacementInvoicePdf: replacement.invoiceId?.pdfPath || '',
        approvalDocuments: replacement.approvalDocuments || [],
        settlementPdf: settlement?.pdfPath || '',
        lrDocuments: replacement.receiveDocuments || [],
        uploadedImages: [
          ...(replacement.receiveImages || []),
          ...(replacement.dispatchImages || []),
        ],
      },
      audit,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/replacements
const createReplacement = async (req, res, next) => {
  try {
    const {
      company, party, receivingDate, receivingTransport, receivingLRNo,
      receivingCases, receivingCartons, receivingRemarks,
    } = req.body;

    assertCompanyAccess(req.user, company);

    // Auto-fill town from party
    const partyDoc = await Party.findById(party);
    if (!partyDoc) throw ApiError.notFound('Party not found');

    const replacementId = await generateReplacementId();

    const replacement = await Replacement.create({
      replacementId,
      company,
      party,
      town: partyDoc.town || '',
      receivingDate,
      receivingTransport: receivingTransport || null,
      receivingLRNo,
      receivingCases: receivingCases || 0,
      receivingCartons: receivingCartons || 0,
      receivingRemarks,
      createdBy: req.user.id,
    });

    // Handle image/document uploads
    if (req.files) {
      if (req.files.receiveImages) {
        replacement.receiveImages = req.files.receiveImages.map(f => f.cloudinaryUrl || `/uploads/images/${f.filename}`);
      }
      if (req.files.receiveDocuments) {
        replacement.receiveDocuments = req.files.receiveDocuments.map(f => f.cloudinaryUrl || `/uploads/documents/${f.filename}`);
      }
      await replacement.save();
    }

    const populated = await Replacement.findById(replacement._id)
      .populate('company', 'name')
      .populate('party', 'name town');

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'CREATE', entity: 'Replacement', entityId: replacement._id,
      description: `Created replacement ${replacementId} for ${partyDoc.name}`,
      newValue: { replacementId, company, party: partyDoc.name, receivingCases },
      ...clientInfo,
    });

    ApiResponse.created(res, populated, 'Replacement created successfully');
  } catch (error) {
    next(error);
  }
};

// PUT /api/replacements/:id
const updateReplacement = async (req, res, next) => {
  try {
    const replacement = await Replacement.findById(req.params.id);
    if (!replacement) throw ApiError.notFound('Replacement not found');
    assertCompanyAccess(req.user, replacement.company);
    if (req.body.company !== undefined) assertCompanyAccess(req.user, req.body.company);

    const oldValue = replacement.toObject();
    const fields = [
      'company', 'party', 'town', 'receivingDate', 'receivingTransport',
      'receivingLRNo', 'receivingCases', 'receivingCartons', 'receivingRemarks',
    ];

    fields.forEach((f) => {
      if (req.body[f] !== undefined) replacement[f] = req.body[f];
    });

    await replacement.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'UPDATE', entity: 'Replacement', entityId: replacement._id,
      description: `Updated replacement ${replacement.replacementId}`,
      oldValue, newValue: replacement.toObject(), ...clientInfo,
    });

    const populated = await Replacement.findById(replacement._id)
      .populate('company', 'name')
      .populate('party', 'name town');

    ApiResponse.success(res, populated, 'Replacement updated');
  } catch (error) {
    next(error);
  }
};

// PUT /api/replacements/:id/dispatch
const updateDispatch = async (req, res, next) => {
  try {
    const replacement = await Replacement.findById(req.params.id);
    if (!replacement) throw ApiError.notFound('Replacement not found');
    assertCompanyAccess(req.user, replacement.company);
    if (replacement.isDispatchLocked && req.user.role !== 'super_admin') {
      throw ApiError.forbidden('Dispatch is locked after company approval. Only Super Admin can unlock/correct it.');
    }

    const { sentDate, dispatchTransport, dispatchLRNo, dispatchCases, dispatchCartons, dispatchRemarks } = req.body;

    replacement.sentDate = sentDate;
    replacement.dispatchTransport = dispatchTransport || null;
    replacement.dispatchLRNo = dispatchLRNo || '';
    replacement.dispatchCases = dispatchCases || 0;
    replacement.dispatchCartons = dispatchCartons || 0;
    replacement.dispatchRemarks = dispatchRemarks || '';

    if (req.files?.dispatchImages) {
      replacement.dispatchImages = req.files.dispatchImages.map(f => f.cloudinaryUrl || `/uploads/images/${f.filename}`);
    }

    await replacement.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'UPDATE', entity: 'Replacement', entityId: replacement._id,
      description: `Dispatch updated for ${replacement.replacementId}`,
      newValue: { sentDate, dispatchLRNo, dispatchCases }, ...clientInfo,
    });

    ApiResponse.success(res, replacement, 'Dispatch updated');
  } catch (error) {
    next(error);
  }
};

// PUT /api/replacements/:id/approval
const updateApproval = async (req, res, next) => {
  try {
    const replacement = await Replacement.findById(req.params.id);
    if (!replacement) throw ApiError.notFound('Replacement not found');
    assertCompanyAccess(req.user, replacement.company);

    const oldApproval = {
      approvalType: replacement.approvalType,
      approvalStatus: replacement.approvalStatus,
      approvalAmount: replacement.approvalAmount,
      approvalProducts: replacement.approvalProducts,
      totalProductApprovalValue: replacement.totalProductApprovalValue,
    };

    const {
      approvalType = replacement.approvalType || 'Amount', approvalStatus, approvalAmount,
      approvedCases, rejectedCases, approvalDate, companyReference, companyRLNo, cnNo, approvalRemark,
    } = req.body;

    let approvalProducts = req.body.approvalProducts;
    if (typeof approvalProducts === 'string' && approvalProducts.trim()) {
      try { approvalProducts = JSON.parse(approvalProducts); } catch (error) { throw ApiError.badRequest('Invalid approval products payload'); }
    }

    replacement.approvalType = approvalType === 'Product' ? 'Product' : 'Amount';
    if (approvalStatus) replacement.approvalStatus = approvalStatus;

    if (replacement.approvalType === 'Amount') {
      const amount = Number(approvalAmount || 0);
      if (approvalStatus && approvalStatus !== 'Pending' && amount <= 0) throw ApiError.badRequest('Approval amount must be greater than zero.');
      replacement.approvalAmount = amount;
      replacement.approvalProducts = [];
      replacement.totalProductApprovalValue = 0;
    } else {
      if (!Array.isArray(approvalProducts)) approvalProducts = [];
      const normalizedProducts = approvalProducts
        .map((product) => ({
          productId: product.productId || null,
          productName: String(product.productName || product.name || '').trim(),
          mrp: Number(product.mrp || 0),
          quantity: Number(product.quantity || 0),
          totalValue: Number(product.totalValue || product.value || product.calculatedValue || 0),
        }))
        .filter((product) => product.productName || product.mrp || product.quantity);
      if (normalizedProducts.length === 0) throw ApiError.badRequest('At least one product approval row is required.');
      normalizedProducts.forEach((product) => {
        if (!product.productName) throw ApiError.badRequest('Product name is required.');
        if (Number.isNaN(product.mrp) || product.mrp < 0) throw ApiError.badRequest('MRP must be numeric and non-negative.');
        if (Number.isNaN(product.quantity) || product.quantity < 0) throw ApiError.badRequest('Quantity must be numeric and non-negative.');
        if (!product.totalValue) product.totalValue = product.mrp * product.quantity;
        if (product.totalValue <= 0) throw ApiError.badRequest('Approved product value must be greater than zero.');
      });
      replacement.approvalAmount = Number(approvalAmount || normalizedProducts.reduce((sum, product) => sum + product.totalValue, 0));
      replacement.approvalProducts = normalizedProducts;
      replacement.totalProductApprovalValue = normalizedProducts.reduce((sum, product) => sum + product.totalValue, 0);
    }

    if (approvedCases !== undefined) replacement.approvedCases = approvedCases;
    if (rejectedCases !== undefined) replacement.rejectedCases = rejectedCases;
    if (approvalDate) replacement.approvalDate = approvalDate;
    if (companyReference !== undefined) replacement.companyReference = companyReference;
    if (companyRLNo !== undefined) {
      replacement.companyRLNo = companyRLNo;
      replacement.companyReference = companyRLNo || replacement.companyReference;
    } else if (companyReference !== undefined && !replacement.companyRLNo) {
      replacement.companyRLNo = companyReference;
    }
    if (cnNo !== undefined) replacement.cnNo = cnNo;
    if (approvalRemark !== undefined) replacement.approvalRemark = approvalRemark;

    if (req.files?.approvalDocuments) {
      replacement.approvalDocuments = [
        ...replacement.approvalDocuments,
        ...req.files.approvalDocuments.map(f => f.cloudinaryUrl || `/uploads/documents/${f.filename}`),
      ];
    }

    const shouldLockDispatch = replacement.approvalStatus === 'Approved' && !replacement.isDispatchLocked;
    if (shouldLockDispatch) {
      replacement.isDispatchLocked = true;
      replacement.dispatchLockedAt = new Date();
      replacement.dispatchLockedBy = req.user.id;
    }

    await replacement.save();

    let settlement = null;
    if (replacement.approvalStatus === 'Approved') {
      settlement = await ensureSettlementForReplacement(replacement, req.user.id);
    }

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'APPROVAL_CHANGED', entity: 'Replacement', entityId: replacement._id,
      description: `Approval updated for ${replacement.replacementId}: ${replacement.approvalType} / ${replacement.approvalStatus}`,
      oldValue: oldApproval,
      newValue: {
        approvalType: replacement.approvalType,
        approvalStatus: replacement.approvalStatus,
        approvalAmount: replacement.approvalAmount,
        approvedCases: replacement.approvedCases,
        rejectedCases: replacement.rejectedCases,
        approvalProducts: replacement.approvalProducts,
        totalProductApprovalValue: replacement.totalProductApprovalValue,
        companyRLNo: replacement.companyRLNo,
        cnNo: replacement.cnNo,
        isDispatchLocked: replacement.isDispatchLocked,
      },
      ...clientInfo,
    });

    if (shouldLockDispatch) {
      await createAuditLog({
        userId: req.user.id, username: req.user.username,
        action: 'DISPATCH_LOCKED', entity: 'Replacement', entityId: replacement._id,
        description: `Dispatch locked after company approval for ${replacement.replacementId}`,
        oldValue: { isDispatchLocked: false },
        newValue: { isDispatchLocked: true, dispatchLockedAt: replacement.dispatchLockedAt },
        ...clientInfo,
      });
    }

    if (settlement) {
      await createAuditLog({
        userId: req.user.id, username: req.user.username,
        action: 'SETTLEMENT_CREATED', entity: 'Settlement', entityId: settlement._id,
        description: `Settlement pending created for ${replacement.replacementId}`,
        newValue: { settlementNo: settlement.settlementNo, replacementId: replacement.replacementId },
        ...clientInfo,
      });
    }

    ApiResponse.success(res, replacement, 'Approval updated');
  } catch (error) {
    next(error);
  }
};

// POST /api/replacements/:id/unlock-dispatch
const unlockDispatch = async (req, res, next) => {
  try {
    const replacement = await Replacement.findById(req.params.id);
    if (!replacement) throw ApiError.notFound('Replacement not found');
    assertCompanyAccess(req.user, replacement.company);
    const oldValue = {
      isDispatchLocked: replacement.isDispatchLocked,
      sentDate: replacement.sentDate,
      dispatchLRNo: replacement.dispatchLRNo,
      dispatchCases: replacement.dispatchCases,
      dispatchCartons: replacement.dispatchCartons,
      invoiceId: replacement.invoiceId,
      invoiceNumber: replacement.invoiceNumber,
    };
    replacement.isDispatchLocked = false;
    replacement.dispatchUnlockedAt = new Date();
    replacement.dispatchUnlockedBy = req.user.id;
    replacement.dispatchUnlockReason = req.body.reason || '';
    await replacement.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'DISPATCH_UNLOCKED',
      entity: 'Replacement',
      entityId: replacement._id,
      description: `Dispatch unlocked for approved replacement ${replacement.replacementId}`,
      oldValue,
      newValue: {
        isDispatchLocked: replacement.isDispatchLocked,
        dispatchUnlockedAt: replacement.dispatchUnlockedAt,
        reason: replacement.dispatchUnlockReason,
      },
      ...clientInfo,
    });

    ApiResponse.success(res, replacement, 'Dispatch unlocked');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getReplacements, getReplacement, createReplacement, updateReplacement,
  getReplacement360, updateDispatch, updateApproval, unlockDispatch,
};


