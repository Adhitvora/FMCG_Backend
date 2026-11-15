const mongoose = require('mongoose');
const MasterCarton = require('../models/masterCarton.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');
const { isReplicaSet } = require('../configs/db.config');
const { applyCompanyScope, assertCompanyAccess } = require('../utils/companyAccess');
const { createMergedCarton, validateMergeSelection } = require('../services/cartonMerge.service');


const runWithOptionalTransaction = async (fn) => {
  if (!isReplicaSet()) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
};

const getMasterCartons = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || paginationConfig.defaultPage;
    const limit = Math.min(parseInt(req.query.limit, 10) || paginationConfig.defaultLimit, paginationConfig.maxLimit);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.company) filter.company = req.query.company;
    applyCompanyScope(filter, req.user, 'company');
    if (req.query.search) filter.cartonNumber = { $regex: req.query.search, $options: 'i' };

    const [cartons, total] = await Promise.all([
      MasterCarton.find(filter)
        .populate('company', 'name')
        .populate('entries.party', 'name town')
        .populate('createdBy', 'username')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      MasterCarton.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, cartons, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
};

const getMasterCarton = async (req, res, next) => {
  try {
    const carton = await MasterCarton.findById(req.params.id)
      .populate('company', 'name')
      .populate('entries.party', 'name town')
      .populate('entries.replacementId', 'replacementId receivingCases cartonStatus')
      .populate('createdBy', 'username');
    if (!carton) throw ApiError.notFound('Master carton not found');
    assertCompanyAccess(req.user, carton.company?._id || carton.company);
    ApiResponse.success(res, carton);
  } catch (error) { next(error); }
};

const createMasterCarton = async (req, res, next) => {
  try {
    const { company, entries } = req.body;
    if (!company) throw ApiError.badRequest('Company is required');
    assertCompanyAccess(req.user, company);
    const replacementIds = validateMergeSelection(entries);
    const carton = await runWithOptionalTransaction((session) => createMergedCarton({
      company,
      replacements: replacementIds.map((_id) => ({ _id })),
      user: req.user,
      session,
    }));

    const populated = await MasterCarton.findById(carton._id).populate('company', 'name').populate('entries.party', 'name town');
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'CARTON_MERGE',
      entity: 'MasterCarton',
      entityId: carton._id,
      description: `Merged ${entries.length} selected parties into carton ${carton.cartonNumber}`,
      newValue: { cartonNumber: carton.cartonNumber, replacementIds, totalCases: carton.totalCases, physicalCaseCount: carton.physicalCaseCount },
      ...clientInfo,
    });

    ApiResponse.created(res, populated, 'Selected parties merged into 1 physical carton');
  } catch (error) { next(error); }
};

const addEntries = async (req, res, next) => {
  try {
    const carton = await MasterCarton.findById(req.params.id);
    if (!carton) throw ApiError.notFound('Master carton not found');
    assertCompanyAccess(req.user, carton.company);
    if (carton.status !== 'Open') throw ApiError.badRequest('Cannot modify a sealed/dispatched carton');
    throw ApiError.badRequest('Add entries is disabled. Create a new merged carton for selected replacements.');
  } catch (error) { next(error); }
};

const removeEntry = async (req, res, next) => {
  try {
    const carton = await MasterCarton.findById(req.params.id);
    if (!carton) throw ApiError.notFound('Master carton not found');
    assertCompanyAccess(req.user, carton.company);
    throw ApiError.conflict('Carton merges are permanent. Participating rows cannot be removed or merged again.');
  } catch (error) { next(error); }
};

const sealCarton = async (req, res, next) => {
  try {
    const carton = await MasterCarton.findById(req.params.id);
    if (!carton) throw ApiError.notFound('Master carton not found');
    assertCompanyAccess(req.user, carton.company);
    if (carton.entries.length === 0) throw ApiError.badRequest('Cannot seal empty carton');
    carton.status = 'Sealed';
    await carton.save();
    ApiResponse.success(res, carton, 'Carton sealed');
  } catch (error) { next(error); }
};

module.exports = { getMasterCartons, getMasterCarton, createMasterCarton, addEntries, removeEntry, sealCarton };
