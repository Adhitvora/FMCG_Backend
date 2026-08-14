const { body, param } = require('express-validator');

const createUserValidator = [
  body('username')
    .trim()
    .notEmpty()
    .withMessage('Username is required')
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be 3-50 characters'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  body('role')
    .notEmpty()
    .withMessage('Role is required')
    .isIn(['super_admin', 'admin', 'operator', 'view_only'])
    .withMessage('Invalid role'),
  body('branch')
    .optional()
    .trim(),
];

const updateUserValidator = [
  param('id')
    .isMongoId()
    .withMessage('Invalid user ID'),
  body('username')
    .optional()
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be 3-50 characters'),
  body('role')
    .optional()
    .isIn(['super_admin', 'admin', 'operator', 'view_only'])
    .withMessage('Invalid role'),
  body('branch')
    .optional()
    .trim(),
];

const resetPasswordValidator = [
  param('id')
    .isMongoId()
    .withMessage('Invalid user ID'),
  body('newPassword')
    .notEmpty()
    .withMessage('New password is required')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
];

const toggleStatusValidator = [
  param('id')
    .isMongoId()
    .withMessage('Invalid user ID'),
];

module.exports = {
  createUserValidator,
  updateUserValidator,
  resetPasswordValidator,
  toggleStatusValidator,
};
