const router = require('express').Router();
const { getDashboardStats } = require('../controllers/dashboard.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);
router.get('/', getDashboardStats);

module.exports = router;
