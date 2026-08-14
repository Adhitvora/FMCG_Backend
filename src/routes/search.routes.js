const router = require('express').Router();
const { searchReplacementParties } = require('../controllers/party.controller');
const auth = require('../middlewares/auth.middleware');

router.use(auth);

router.get('/parties', searchReplacementParties);

module.exports = router;
