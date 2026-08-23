const AuditLog = require('../models/auditLog.model');

/**
 * Creates an audit log entry.
 * Can be called directly from controllers/services.
 */
const createAuditLog = async ({
  userId,
  username,
  action,
  entity,
  entityId = null,
  description = '',
  oldValue = null,
  newValue = null,
  ip = '',
  browser = '',
  session = null,
}) => {
  try {
    const auditLog = {
      userId,
      username,
      action,
      entity,
      entityId,
      description,
      oldValue,
      newValue,
      ip,
      browser,
    };

    if (session) {
      await AuditLog.create([auditLog], { session });
    } else {
      await AuditLog.create(auditLog);
    }
  } catch (error) {
    // Audit logging should never break the main flow
    console.error('Audit log error:', error.message);
  }
};

/**
 * Extract client info from request for audit logging.
 */
const getClientInfo = (req) => {
  return {
    ip: req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '',
    browser: req.headers['user-agent'] || '',
  };
};

module.exports = { createAuditLog, getClientInfo };
