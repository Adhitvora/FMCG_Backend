const { body, param } = require('express-validator');

const createTransportValidator = [
  body('name').trim().notEmpty().withMessage('Transport name is required'),
  body('contact').optional().trim(),
  body('gst').optional().trim(),
  body('branch').optional().trim(),
];

const updateTransportValidator = [
  param('id').isMongoId().withMessage('Invalid transport ID'),
  body('name').optional().trim().notEmpty().withMessage('Transport name cannot be empty'),
  body('contact').optional().trim(),
  body('gst').optional().trim(),
  body('branch').optional().trim(),
];

module.exports = { createTransportValidator, updateTransportValidator };
