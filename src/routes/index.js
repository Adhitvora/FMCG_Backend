const router = require('express').Router();

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const companyRoutes = require('./company.routes');
const partyRoutes = require('./party.routes');
const transportRoutes = require('./transport.routes');
const replacementRoutes = require('./replacement.routes');
const masterCartonRoutes = require('./masterCarton.routes');
const invoiceRoutes = require('./invoice.routes');
const dashboardRoutes = require('./dashboard.routes');
const auditLogRoutes = require('./auditLog.routes');
const partyListRoutes = require('./partyList.routes');
const settlementRoutes = require('./settlement.routes');
const searchRoutes = require('./search.routes');

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/companies', companyRoutes);
router.use('/parties', partyRoutes);
router.use('/transports', transportRoutes);
router.use('/replacements', replacementRoutes);
router.use('/master-cartons', masterCartonRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/audit-logs', auditLogRoutes);
router.use('/party-list', partyListRoutes);
router.use('/settlements', settlementRoutes);
router.use('/search', searchRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ success: true, message: 'API is running', timestamp: new Date() });
});

module.exports = router;
