const mongoose = require('mongoose');
const MasterCarton = require('../models/masterCarton.model');
const Replacement = require('../models/replacement.model');
const Company = require('../models/company.model');
const Counter = require('../models/counter.model');
const ApiError = require('../utils/apiError');
const { assertCompanyAccess } = require('../utils/companyAccess');

const ALREADY_MERGED = 'These cartons are already merged and cannot be merged again.';
const sessionOpt = (session) => (session ? { session } : {});
const withSession = (query, session) => (session ? query.session(session) : query);
const idOf = (value) => String(value?._id || value || '');

const validateMergeSelection = (entries) => {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw ApiError.badRequest('Select at least two replacement rows to merge.');
  }
  const ids = entries.map((entry) => idOf(entry?.replacementId));
  if (ids.some((id) => !mongoose.isObjectIdOrHexString(id))) {
    throw ApiError.badRequest('Every selected row must include a valid replacement ID.');
  }
  const normalizedIds = ids.map((id) => id.toLowerCase());
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw ApiError.badRequest('Duplicate replacement selected in this merge.');
  }
  return normalizedIds;
};

// The same compare-and-set conditions are used for validation and each atomic claim.
// A failed standalone operation releases only claims owned by that attempt.
const unmergedConditions = () => ({
  status: 'active',
  invoiceId: null,
  cartonId: null,
  masterCartonId: null,
  cartonMergedAt: null,
  cartonMergedBy: null,
  $or: [{ cartonStatus: 'AVAILABLE' }, { cartonStatus: null }],
});

const createCartonMergeService = (dependencies = {}) => {
  const CartonModel = dependencies.MasterCarton || MasterCarton;
  const ReplacementModel = dependencies.Replacement || Replacement;
  const CompanyModel = dependencies.Company || Company;
  const CounterModel = dependencies.Counter || Counter;

  const createMergedCarton = async ({ company, replacements, user, session = null }) => {
    if (!user?.id) throw ApiError.unauthorized('Authentication required');
    if (!['super_admin', 'admin', 'operator'].includes(user.role)) {
      throw ApiError.forbidden('You do not have permission to merge cartons.');
    }
    if (!mongoose.isObjectIdOrHexString(company?._id || company)) {
      throw ApiError.badRequest('A valid company is required.');
    }
    const companyId = idOf(company);
    assertCompanyAccess(user, companyId);
    const ids = validateMergeSelection(replacements?.map((rep) => ({ replacementId: rep._id })));
    const companyDoc = await withSession(CompanyModel.findById(companyId), session);
    if (!companyDoc || companyDoc.status !== 'active') {
      throw ApiError.badRequest('Select an active company for this carton merge.');
    }
    const savedRows = await withSession(ReplacementModel.find({ _id: { $in: ids }, company: companyId })
      .populate('party', 'name town status'), session);
    if (savedRows.length !== ids.length) {
      throw ApiError.badRequest('All selected replacements must belong to the same company and replacement context.');
    }
    const byId = new Map(savedRows.map((rep) => [idOf(rep._id), rep]));
    const orderedRows = ids.map((id) => byId.get(id));
    const inputById = new Map(replacements.map((rep) => [idOf(rep._id), rep]));
    const snapshotFields = ['receivingCases', 'party', 'town', 'receivingLRNo', 'isDispatchLocked'];
    for (const rep of orderedRows) {
      if (rep.cartonId || rep.masterCartonId || rep.cartonMergedAt || rep.cartonMergedBy || rep.cartonStatus === 'MERGED') {
        throw ApiError.conflict(ALREADY_MERGED);
      }
      if (rep.status !== 'active' || rep.invoiceId || (rep.cartonStatus && rep.cartonStatus !== 'AVAILABLE')) {
        throw ApiError.conflict('Only active, uninvoiced and available replacements can be merged.');
      }
      if (!rep.party?._id || !rep.party.name || rep.party.status !== 'active') {
        throw ApiError.badRequest('Every selected replacement must have an active party.');
      }
      if (!Number.isSafeInteger(rep.receivingCases) || rep.receivingCases < 1) {
        throw ApiError.badRequest(`Replacement ${rep.replacementId || rep._id} must have a positive whole-number received case quantity.`);
      }
      // Invoice generation supplies its rendered snapshot; a plain merge request
      // supplies only IDs. Do not commit a permanent merge for a stale invoice.
      const input = inputById.get(idOf(rep._id));
      if (snapshotFields.some((field) => input[field] !== undefined &&
        (field === 'party' ? idOf(input[field]) !== idOf(rep[field]) : input[field] !== rep[field]))) {
        throw ApiError.conflict('A selected replacement changed while preparing the merge. Refresh the selection and try again.');
      }
    }
    // Protect historic groups even if a legacy record has lost its reverse link.
    const existingGroup = await withSession(CartonModel.findOne({ 'entries.replacementId': { $in: ids } }), session);
    if (existingGroup) throw ApiError.conflict(ALREADY_MERGED);

    const cartonNumber = await CounterModel.getNextSequence('master_carton', session);
    const cartonGroupNumber = await CounterModel.getNextSequence('carton_group', session);
    const carton = new CartonModel({
      cartonNumber: `MC${String(cartonNumber).padStart(5, '0')}`,
      company: companyId,
      status: 'Open',
      physicalCaseCount: 1,
      createdBy: user.id,
      entries: orderedRows.map((rep) => ({
        party: rep.party._id,
        partyName: rep.party.name,
        cases: rep.receivingCases,
        replacementId: rep._id,
      })),
    });
    await carton.validate();
    const assignment = {
      masterCartonId: carton._id,
      cartonId: carton._id,
      cartonStatus: 'MERGED',
      cartonGroupNumber,
      cartonMergedAt: new Date(),
      cartonMergedBy: user.id,
    };
    let saveAttempted = false;
    try {
      // Deterministic order avoids cyclic partial claims for overlapping requests.
      for (const rep of [...orderedRows].sort((a, b) => idOf(a._id).localeCompare(idOf(b._id)))) {
        const input = inputById.get(idOf(rep._id));
        const snapshotConditions = {};
        for (const field of ['town', 'receivingLRNo', 'isDispatchLocked']) {
          if (input[field] !== undefined) {
            // Defaults also match older documents where the field was absent.
            snapshotConditions[field] = input[field] === '' || input[field] === false
              ? { $in: [input[field], null] } : input[field];
          }
        }
        const result = await ReplacementModel.updateOne({
          _id: rep._id,
          company: companyId,
          party: rep.party._id,
          receivingCases: rep.receivingCases,
          ...snapshotConditions,
          ...unmergedConditions(),
        }, { $set: assignment }, sessionOpt(session));
        if (result.modifiedCount !== 1) {
          throw ApiError.conflict('One or more selected cartons were merged, invoiced or changed by another request. Refresh the list and select available rows.');
        }
      }
      saveAttempted = true;
      await carton.save(sessionOpt(session));
    } catch (error) {
      if (!session) {
        // A lost acknowledgement may follow a successful save. A complete stored
        // carton is committed and must never be undone by error compensation.
        if (saveAttempted) {
          const persisted = await CartonModel.findById(carton._id);
          if (persisted) {
            for (const rep of replacements) Object.assign(rep, assignment);
            return persisted;
          }
        }
        // Include all selected IDs: a network error can occur after a claim applied.
        // Ownership predicates prevent this cleanup from releasing another request.
        await ReplacementModel.updateMany({
          _id: { $in: ids },
          cartonId: carton._id,
          masterCartonId: carton._id,
          invoiceId: null,
          cartonStatus: 'MERGED',
        }, { $set: {
          masterCartonId: null,
          cartonId: null,
          cartonStatus: 'AVAILABLE',
          cartonGroupNumber: null,
          cartonMergedAt: null,
          cartonMergedBy: null,
        } });
      }
      throw error;
    }
    for (const rep of replacements) Object.assign(rep, assignment);
    return carton;
  };

  return { createMergedCarton };
};

module.exports = {
  ...createCartonMergeService(),
  createCartonMergeService,
  validateMergeSelection,
  unmergedConditions,
};
