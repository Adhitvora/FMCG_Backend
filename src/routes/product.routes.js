const router = require('express').Router();
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  searchProducts,
  downloadSampleExcel,
  previewImport,
  importProducts,
} = require('../controllers/product.controller');
const auth = require('../middlewares/auth.middleware');
const rbac = require('../middlewares/rbac.middleware');
const upload = require('../middlewares/upload.middleware');

router.use(auth);

router.get('/', getProducts);
router.get('/search', searchProducts);
router.get('/sample-excel', downloadSampleExcel);
router.get('/:id', getProduct);
router.post('/', rbac('super_admin', 'admin', 'operator'), createProduct);
router.post('/import/preview', rbac('super_admin', 'admin'), upload.single('file'), previewImport);
router.post('/import', rbac('super_admin', 'admin'), upload.single('file'), importProducts);
router.put('/:id', rbac('super_admin', 'admin'), updateProduct);
router.delete('/:id', rbac('super_admin'), deleteProduct);

module.exports = router;
