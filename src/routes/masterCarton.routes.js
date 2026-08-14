const router = require('express').Router();
const {
  getMasterCartons, getMasterCarton, createMasterCarton,
  addEntries, removeEntry, sealCarton,
} = require('../controllers/masterCarton.controller');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');

router.use(auth);

router.get('/', getMasterCartons);
router.get('/:id', getMasterCarton);
router.post('/', rbac('super_admin', 'admin', 'operator'), createMasterCarton);
router.put('/:id/add', rbac('super_admin', 'admin', 'operator'), addEntries);
router.put('/:id/remove', rbac('super_admin', 'admin', 'operator'), removeEntry);
router.put('/:id/seal', rbac('super_admin', 'admin'), sealCarton);

module.exports = router;
