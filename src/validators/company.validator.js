const { body, param } = require('express-validator');

const createCompanyValidator = [
  body('name').trim().notEmpty().withMessage('Company name is required'),
  body('address').optional().trim(),
  body('gst').optional().trim(),
  body('contact').optional().trim(),
  body('email').optional().trim().isEmail().withMessage('Invalid email'),
  body('approvalDays').optional().isInt({ min: 0 }).withMessage('Approval days must be a positive number'),
  body('invoicePrefix').optional().trim(),
];

const updateCompanyValidator = [
  param('id').isMongoId().withMessage('Invalid company ID'),
  ...createCompanyValidator.map((v) => v.optional ? v : v),
];

module.exports = { createCompanyValidator, updateCompanyValidator };
