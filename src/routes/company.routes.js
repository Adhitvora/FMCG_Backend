const router = require('express').Router();
const { getCompanies, getAllCompanies, getCompany, createCompany, updateCompany, deleteCompany } = require('../controllers/company.controller');
const { createCompanyValidator } = require('../validators/company.validator');
const validate = require('../middlewares/validate.middleware');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');
const upload = require('../middlewares/upload.middleware');
const cloudinaryUpload = require('../middlewares/cloudinaryUpload.middleware');

router.use(auth);

router.get('/', getCompanies);
router.get('/all', getAllCompanies);
router.get('/:id', getCompany);
router.post('/', rbac('super_admin', 'admin', 'operator'), upload.single('logo'), cloudinaryUpload, createCompanyValidator, validate, createCompany);
router.put('/:id', rbac('super_admin', 'admin'), upload.single('logo'), cloudinaryUpload, updateCompany);
router.delete('/:id', rbac('super_admin'), deleteCompany);

module.exports = router;
