const { validationResult } = require('express-validator');
const ApiError = require('../utils/apiError');

/**
 * Runs express-validator validations and returns errors if any.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const extractedErrors = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    }));
    throw ApiError.badRequest('Validation failed', extractedErrors);
  }
  next();
};

module.exports = validate;
