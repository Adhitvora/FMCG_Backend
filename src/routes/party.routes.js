const router = require('express').Router();
const {
  getParties, getAllParties, getParty, createParty, updateParty, deleteParty,
  getPartyReplacementSummary, downloadSampleExcel, importParties,
} = require('../controllers/party.controller');
const { createPartyValidator, updatePartyValidator } = require('../validators/party.validator');
const validate = require('../middlewares/validate.middleware');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');
const upload = require('../middlewares/upload.middleware');

router.use(auth);

router.get('/', getParties);
router.get('/all', getAllParties);
router.get('/sample-excel', downloadSampleExcel);
router.get('/:id/replacement-summary', getPartyReplacementSummary);
router.get('/:id', getParty);
router.post('/', rbac('super_admin', 'admin', 'operator'), createPartyValidator, validate, createParty);
router.post('/import', rbac('super_admin', 'admin'), upload.single('excelFile'), importParties);
router.put('/:id', rbac('super_admin', 'admin'), updatePartyValidator, validate, updateParty);
router.delete('/:id', rbac('super_admin'), deleteParty);

module.exports = router;
