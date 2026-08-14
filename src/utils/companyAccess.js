const mongoose = require('mongoose');
const ApiError = require('./apiError');

const toStringId = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  return String(value);
};

const getAllowedCompanyIds = (user = {}) => {
  if (user.role === 'super_admin') return null;

  const ids = [];
  if (user.company) ids.push(toStringId(user.company));
  if (Array.isArray(user.companies)) {
    user.companies.forEach((id) => ids.push(toStringId(id)));
  }

  return [...new Set(ids.filter(Boolean))];
};

const hasCompanyAssignments = (user = {}) => {
  const allowed = getAllowedCompanyIds(user);
  return allowed === null || allowed.length > 0;
};

const assertCompanyAccess = (user, companyId) => {
  const allowed = getAllowedCompanyIds(user);
  if (allowed === null) return;

  if (!allowed.length) return; // Backward compatibility for existing unassigned users.

  if (!allowed.includes(toStringId(companyId))) {
    throw ApiError.forbidden('You do not have access to this company.');
  }
};

const applyCompanyScope = (filter, user, field = 'company') => {
  const allowed = getAllowedCompanyIds(user);
  if (allowed === null || !allowed.length) return filter;

  const objectIds = allowed
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (!objectIds.length) {
    filter[field] = { $in: [] };
    return filter;
  }

  if (filter[field]) {
    assertCompanyAccess(user, filter[field]);
  } else {
    filter[field] = { $in: objectIds };
  }

  return filter;
};

module.exports = {
  applyCompanyScope,
  assertCompanyAccess,
  getAllowedCompanyIds,
  hasCompanyAssignments,
};
