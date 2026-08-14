const AuditLog = require('../models/auditLog.model');
const ApiResponse = require('../utils/apiResponse');
const { pagination: paginationConfig } = require('../configs/app.config');

// GET /api/audit-logs
const getAuditLogs = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || paginationConfig.defaultPage;
    const limit = Math.min(parseInt(req.query.limit) || paginationConfig.defaultLimit, paginationConfig.maxLimit);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.entity) filter.entity = req.query.entity;
    if (req.query.action) filter.action = req.query.action;
    if (req.query.username) filter.username = { $regex: req.query.username, $options: 'i' };
    if (req.query.search) {
      filter.$or = [
        { description: { $regex: req.query.search, $options: 'i' } },
        { username: { $regex: req.query.search, $options: 'i' } },
        { entity: { $regex: req.query.search, $options: 'i' } },
      ];
    }
    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.createdAt.$lte = new Date(req.query.dateTo + 'T23:59:59');
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, logs, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
};

module.exports = { getAuditLogs };
