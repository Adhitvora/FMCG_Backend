const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { upload: uploadConfig } = require('../configs/app.config');
const { isCloudinaryConfigured } = require('../configs/cloudinary.config');
const ApiError = require('../utils/apiError');

// Ensure upload directories exist (for local fallback)
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Disk storage (fallback when Cloudinary not configured)
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadDir = uploadConfig.path;

    // Organize uploads by type
    if (file.fieldname === 'logo') {
      uploadDir = path.join(uploadDir, 'logos');
    } else if (file.fieldname === 'images' || file.fieldname === 'receiveImages' || file.fieldname === 'dispatchImages') {
      uploadDir = path.join(uploadDir, 'images');
    } else if (file.fieldname === 'documents' || file.fieldname === 'approvalDocuments' || file.fieldname === 'receiveDocuments') {
      uploadDir = path.join(uploadDir, 'documents');
    } else if (file.fieldname === 'excelFile') {
      uploadDir = path.join(uploadDir, 'imports');
    } else {
      uploadDir = path.join(uploadDir, 'misc');
    }

    ensureDir(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

// Memory storage (for Cloudinary — buffers uploaded to cloud)
const memStorage = multer.memoryStorage();

// File filter
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
    'application/vnd.ms-excel', // xls
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, `File type ${file.mimetype} is not allowed`), false);
  }
};

// Use memory storage when Cloudinary is configured, otherwise use disk
const upload = multer({
  storage: isCloudinaryConfigured() ? memStorage : diskStorage,
  fileFilter,
  limits: {
    fileSize: uploadConfig.maxFileSize,
  },
});

module.exports = upload;
