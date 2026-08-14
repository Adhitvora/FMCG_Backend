const router = require('express').Router();
const { getAuditLogs } = require('../controllers/auditLog.controller');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');

router.use(auth);
router.get('/', rbac('super_admin', 'admin'), getAuditLogs);

module.exports = router;
