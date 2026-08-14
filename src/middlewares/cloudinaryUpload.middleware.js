const { uploadToCloudinary, getFolderForField, isCloudinaryConfigured } = require('../configs/cloudinary.config');

/**
 * Middleware that runs AFTER multer (memoryStorage).
 * Takes file buffers from req.file / req.files and uploads them to Cloudinary.
 * Sets cloudinaryUrl on each file object for controllers to use.
 * Falls back to local paths when Cloudinary is not configured.
 */
const cloudinaryUpload = async (req, res, next) => {
  if (!isCloudinaryConfigured()) {
    return next(); // Skip — use local disk paths
  }

  try {
    // Handle single file (req.file)
    if (req.file && req.file.buffer) {
      const folder = getFolderForField(req.file.fieldname);
      const result = await uploadToCloudinary(req.file.buffer, folder);
      req.file.cloudinaryUrl = result.secure_url;
      req.file.cloudinaryPublicId = result.public_id;
    }

    // Handle multiple files (req.files — from upload.fields())
    if (req.files && typeof req.files === 'object') {
      for (const fieldname of Object.keys(req.files)) {
        const files = req.files[fieldname];
        for (const file of files) {
          if (file.buffer) {
            const folder = getFolderForField(fieldname);
            const result = await uploadToCloudinary(file.buffer, folder);
            file.cloudinaryUrl = result.secure_url;
            file.cloudinaryPublicId = result.public_id;
          }
        }
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = cloudinaryUpload;
