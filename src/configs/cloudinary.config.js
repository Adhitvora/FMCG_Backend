const cloudinary = require('cloudinary').v2;
const path = require('path');

// Configure Cloudinary from environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const CLOUDINARY_ROOT = 'fmcg-erp';

/**
 * Map a field name to a Cloudinary folder path.
 * Folder structure: fmcg-erp/{category}/
 */
const getFolderForField = (fieldname) => {
  const folderMap = {
    logo: 'logos',
    receiveImages: 'images',
    dispatchImages: 'images',
    images: 'images',
    receiveDocuments: 'documents',
    approvalDocuments: 'documents',
    documents: 'documents',
    excelFile: 'imports',
    invoicePdf: 'invoices',
  };

  return `${CLOUDINARY_ROOT}/${folderMap[fieldname] || 'misc'}`;
};

/**
 * Upload a file buffer to Cloudinary.
 * @param {Buffer} fileBuffer - The file buffer to upload
 * @param {string} folder - The Cloudinary folder path
 * @param {string} [filename] - Optional custom public_id (without extension)
 * @param {string} [resourceType] - 'image', 'raw', or 'auto' (default: 'auto')
 * @returns {Promise<object>} Cloudinary upload result
 */
const uploadToCloudinary = (fileBuffer, folder, filename, resourceType = 'auto') => {
  return new Promise((resolve, reject) => {
    const options = {
      folder,
      resource_type: resourceType,
      use_filename: true,
      unique_filename: true,
    };

    if (filename) {
      options.public_id = filename;
    }

    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });

    uploadStream.end(fileBuffer);
  });
};

/**
 * Upload a file from disk to Cloudinary.
 * @param {string} filePath - Absolute path to the file
 * @param {string} folder - The Cloudinary folder path
 * @param {string} [filename] - Optional custom public_id
 * @param {string} [resourceType] - 'image', 'raw', or 'auto' (default: 'auto')
 * @returns {Promise<object>} Cloudinary upload result
 */
const uploadFileToCloudinary = async (filePath, folder, filename, resourceType = 'auto') => {
  const options = {
    folder,
    resource_type: resourceType,
    use_filename: true,
    unique_filename: true,
  };

  if (filename) {
    options.public_id = filename;
  }

  return cloudinary.uploader.upload(filePath, options);
};

/**
 * Delete a file from Cloudinary by its public_id.
 * @param {string} publicId - The Cloudinary public_id
 * @param {string} [resourceType] - 'image', 'raw', or 'auto'
 * @returns {Promise<object>}
 */
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
};

/**
 * Check if Cloudinary is configured with real credentials.
 */
const isCloudinaryConfigured = () => {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  return !!(
    cloud_name && cloud_name !== 'your_cloud_name' &&
    api_key && api_key !== 'your_api_key' &&
    api_secret && api_secret !== 'your_api_secret'
  );
};

module.exports = {
  cloudinary,
  uploadToCloudinary,
  uploadFileToCloudinary,
  deleteFromCloudinary,
  getFolderForField,
  isCloudinaryConfigured,
  CLOUDINARY_ROOT,
};
