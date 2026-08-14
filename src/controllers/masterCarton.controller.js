const mongoose = require('mongoose');
const MasterCarton = require('../models/masterCarton.model');
const Replacement = require('../models/replacement.model');
const Counter = require('../models/counter.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');
const { isReplicaSet } = require('../configs/db.config');
const { applyCompanyScope, assertCompanyAccess } = require('../utils/companyAccess');

const sessionOpt = (session) => (session ? { session } : {});
const withSession = (query, session) => (session ? query.session(session) : query);

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

const generateCartonNumber = async (session) => {
  const seq = await Counter.getNextSequence('master_carton', session);
  return `MC${String(seq).padStart(5, '0')}`;
};

const validateEntries = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) throw ApiError.badRequest('At least one entry is required');
  const ids = entries.map((entry) => String(entry.replacementId || '')).filter(Boolean);
  if (ids.length !== entries.length) throw ApiError.badRequest('Every entry must include a replacement');
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('Duplicate replacement selected in this merge');
  return ids;
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
    const replacementIds = validateEntries(entries);

    const carton = await runWithOptionalTransaction(async (session) => {
      const replacements = await withSession(Replacement.find({
        _id: { $in: replacementIds },
        company,
        status: 'active',
      }).populate('party', 'name town'), session);

      if (replacements.length !== replacementIds.length) throw ApiError.badRequest('One or more replacements are unavailable.');
      const unavailable = replacements.find((rep) => rep.cartonId || rep.masterCartonId || rep.cartonStatus === 'MERGED' || rep.cartonStatus === 'DISPATCHED');
      if (unavailable) throw ApiError.conflict('This replacement is already assigned to another carton.');

      const cartonNumber = await generateCartonNumber(session);
      const cartonGroupNumber = await Counter.getNextSequence('carton_group', session);
      const byId = new Map(replacements.map((rep) => [String(rep._id), rep]));
      const normalizedEntries = replacementIds.map((id) => {
        const rep = byId.get(id);
        return {
          party: rep.party?._id || rep.party,
          partyName: rep.party?.name || entries.find((e) => String(e.replacementId) === id)?.partyName || '',
          cases: Number(rep.receivingCases || 0),
          replacementId: rep._id,
        };
      });

      const created = new MasterCarton({
        cartonNumber,
        entries: normalizedEntries,
        company,
        status: 'Open',
        createdBy: req.user.id,
      });
      await created.save(sessionOpt(session));

      const updateResult = await Replacement.updateMany(
        {
          _id: { $in: replacementIds },
          company,
          status: 'active',
          invoiceId: null,
          $or: [
            { cartonId: null }, { cartonId: { $exists: false } },
          ],
          $and: [
            { $or: [{ masterCartonId: null }, { masterCartonId: { $exists: false } }] },
            { $or: [{ cartonStatus: 'AVAILABLE' }, { cartonStatus: { $exists: false } }] },
          ],
        },
        {
          $set: {
            masterCartonId: created._id,
            cartonId: created._id,
            cartonStatus: 'MERGED',
            cartonGroupNumber,
            cartonMergedAt: new Date(),
            cartonMergedBy: req.user.id,
          },
        },
        sessionOpt(session),
      );

      if (updateResult.modifiedCount !== replacementIds.length) {
        throw ApiError.conflict('This replacement is already assigned to another carton.');
      }

      return created;
    });

    const populated = await MasterCarton.findById(carton._id).populate('company', 'name').populate('entries.party', 'name town');
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'CARTON_MERGE',
      entity: 'MasterCarton',
      entityId: carton._id,
      description: `Merged ${entries.length} selected parties into carton ${carton.cartonNumber}`,
      newValue: { cartonNumber: carton.cartonNumber, replacementIds, totalCases: carton.totalCases },
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
    if (req.user.role !== 'super_admin') throw ApiError.forbidden('Only Super Admin can unmerge cartons.');
    if (carton.status !== 'Open') throw ApiError.badRequest('Cannot modify a sealed/dispatched carton');

    const { replacementId } = req.body;
    const entryIdx = carton.entries.findIndex((entry) => String(entry.replacementId) === String(replacementId));
    if (entryIdx === -1) throw ApiError.notFound('Entry not found in carton');
    carton.entries.splice(entryIdx, 1);
    await carton.save();
    await Replacement.findByIdAndUpdate(replacementId, {
      masterCartonId: null,
      cartonId: null,
      cartonStatus: 'AVAILABLE',
      cartonGroupNumber: null,
      cartonMergedAt: null,
      cartonMergedBy: null,
    });
    ApiResponse.success(res, carton, 'Entry removed');
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
