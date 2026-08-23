const router = require('express').Router();
const {
  cancelSettlement,
  calculateSettlementPreview,
  completeSettlement,
  createSettlement,
  getCompanySettlements,
  getPartySettlements,
  getPendingSettlements,
  getSettlement,
  getSettlementDashboard,
  getSettlementPDF,
  getSettlements,
  unlockSettlement,
  updateSettlement,
} = require('../controllers/settlement.controller');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');

router.use(auth);

router.get('/', getSettlements);
router.get('/pending', getPendingSettlements);
router.get('/dashboard', getSettlementDashboard);
router.get('/party/:partyId', getPartySettlements);
router.get('/company/:companyId', getCompanySettlements);
router.get('/:id', getSettlement);
router.get('/:id/pdf', getSettlementPDF);
router.post('/', rbac('super_admin', 'admin', 'operator'), createSettlement);
router.put('/:id', rbac('super_admin', 'admin', 'operator'), updateSettlement);
router.post('/:id/calculate', rbac('super_admin', 'admin', 'operator'), calculateSettlementPreview);
router.post('/:id/complete', rbac('super_admin', 'admin', 'operator'), completeSettlement);
router.post('/:id/cancel', rbac('super_admin'), cancelSettlement);
router.post('/:id/unlock', rbac('super_admin'), unlockSettlement);

module.exports = router;
