const router = require('express').Router();
const {
  getReplacements, getReplacement, createReplacement,
  getReplacement360, updateReplacement, updateDispatch, updateApproval, unlockDispatch,
} = require('../controllers/replacement.controller');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');
const upload = require('../middlewares/upload.middleware');
const cloudinaryUpload = require('../middlewares/cloudinaryUpload.middleware');

router.use(auth);

const multiUpload = upload.fields([
  { name: 'receiveImages', maxCount: 5 },
  { name: 'receiveDocuments', maxCount: 5 },
  { name: 'dispatchImages', maxCount: 5 },
  { name: 'approvalDocuments', maxCount: 5 },
]);

router.get('/', getReplacements);
router.get('/:id/360', getReplacement360);
router.get('/:id', getReplacement);
router.post('/', rbac('super_admin', 'admin', 'operator'), multiUpload, cloudinaryUpload, createReplacement);
router.put('/:id', rbac('super_admin', 'admin', 'operator'), updateReplacement);
router.put('/:id/dispatch', rbac('super_admin', 'admin', 'operator'), multiUpload, cloudinaryUpload, updateDispatch);
router.put('/:id/approval', rbac('super_admin', 'admin'), multiUpload, cloudinaryUpload, updateApproval);
router.post('/:id/unlock-dispatch', rbac('super_admin'), unlockDispatch);

module.exports = router;
