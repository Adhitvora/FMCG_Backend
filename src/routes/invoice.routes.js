const router = require('express').Router();
const {
  getInvoices,
  getInvoice,
  getInvoiceHtml,
  createInvoice,
  cancelInvoice,
  getInvoicePDF,
  reprintInvoice,
  trackPrint,
  unlockInvoice,
} = require('../controllers/invoice.controller');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');

router.use(auth);

router.get('/', getInvoices);
router.get('/:id', getInvoice);
router.get('/:id/pdf', getInvoicePDF);
router.get('/:id/html', getInvoiceHtml);
router.post('/', rbac('super_admin', 'admin'), createInvoice);
router.post('/:id/reprint', rbac('super_admin', 'admin'), reprintInvoice);
router.post('/:id/regenerate-pdf', rbac('super_admin', 'admin'), reprintInvoice);
router.post('/:id/print', trackPrint);
router.post('/:id/unlock', rbac('super_admin'), unlockInvoice);
router.put('/:id/cancel', rbac('super_admin'), cancelInvoice);

module.exports = router;

