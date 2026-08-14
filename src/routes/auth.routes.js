const router = require('express').Router();
const { login, refreshToken, logout, getMe } = require('../controllers/auth.controller');
const { loginValidator, refreshTokenValidator } = require('../validators/auth.validator');
const validate = require('../middlewares/validate.middleware');
const auth = require('../middlewares/auth.middleware');

router.post('/login', loginValidator, validate, login);
router.post('/refresh', refreshTokenValidator, validate, refreshToken);
router.post('/logout', auth, logout);
router.get('/me', auth, getMe);

module.exports = router;
