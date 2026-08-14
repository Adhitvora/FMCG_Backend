const router = require('express').Router();
const { generatePartyListPDF, getPartyListData } = require('../controllers/partyList.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);

// GET /api/party-list/:companyId/pdf
router.get('/:companyId/pdf', generatePartyListPDF);

// POST /api/party-list/generate
router.post('/generate', getPartyListData);

module.exports = router;
