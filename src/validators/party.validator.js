const { body, param } = require('express-validator');

const createPartyValidator = [
  body('name').trim().notEmpty().withMessage('Party name is required'),
  body('town').optional().trim(),
  body('gst').optional().trim(),
  body('mobile').optional().trim(),
  body('address').optional().trim(),
  body('route').optional().trim(),
  body('transport').optional().isMongoId().withMessage('Invalid transport ID'),
];

const updatePartyValidator = [
  param('id').isMongoId().withMessage('Invalid party ID'),
  body('name').optional().trim().notEmpty().withMessage('Party name cannot be empty'),
  body('town').optional().trim(),
  body('gst').optional().trim(),
  body('mobile').optional().trim(),
  body('address').optional().trim(),
  body('route').optional().trim(),
  body('transport').optional(),
];

module.exports = { createPartyValidator, updatePartyValidator };
