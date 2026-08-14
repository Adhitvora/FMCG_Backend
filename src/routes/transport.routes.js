const router = require('express').Router();
const { getTransports, getAllTransports, getTransport, createTransport, updateTransport, deleteTransport } = require('../controllers/transport.controller');
const { createTransportValidator, updateTransportValidator } = require('../validators/transport.validator');
const validate = require('../middlewares/validate.middleware');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');

router.use(auth);

router.get('/', getTransports);
router.get('/all', getAllTransports);
router.get('/:id', getTransport);
router.post('/', rbac('super_admin', 'admin', 'operator'), createTransportValidator, validate, createTransport);
router.put('/:id', rbac('super_admin', 'admin'), updateTransportValidator, validate, updateTransport);
router.delete('/:id', rbac('super_admin'), deleteTransport);

module.exports = router;
