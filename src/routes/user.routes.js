const router = require('express').Router();
const {
  getUsers,
  getUser,
  createUser,
  updateUser,
  resetPassword,
  toggleStatus,
  deleteUser,
} = require('../controllers/user.controller');
const {
  createUserValidator,
  updateUserValidator,
  resetPasswordValidator,
  toggleStatusValidator,
} = require('../validators/user.validator');
const validate = require('../middlewares/validate.middleware');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');

// All user routes require authentication and super_admin role
router.use(auth);
router.use(rbac('super_admin'));

router.get('/', getUsers);
router.get('/:id', getUser);
router.post('/', createUserValidator, validate, createUser);
router.put('/:id', updateUserValidator, validate, updateUser);
router.put('/:id/reset-password', resetPasswordValidator, validate, resetPassword);
router.put('/:id/toggle-status', toggleStatusValidator, validate, toggleStatus);
router.delete('/:id', deleteUser);

module.exports = router;
