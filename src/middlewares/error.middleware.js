const ApiError = require('../utils/apiError');
const multer = require('multer');

// Global error handler middleware
const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Error:', err);
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    error = ApiError.badRequest(`Invalid ${err.path}: ${err.value}`);
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0];
    const value = err.keyValue?.[field];
    error = ApiError.conflict(
      `Duplicate value for '${field}': '${value}'. Please use a different value.`
    );
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    error = ApiError.badRequest('Validation Error', messages);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error = ApiError.unauthorized('Invalid token');
  }
  if (err.name === 'TokenExpiredError') {
    error = ApiError.unauthorized('Token expired');
  }

  if (err instanceof multer.MulterError || err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const message = req.originalUrl?.includes('/products/import')
        ? 'Excel file is too large. Maximum allowed size is 10 MB.'
        : 'Uploaded file is too large. Maximum allowed size is 10 MB.';
      error = ApiError.badRequest(message);
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      error = ApiError.badRequest('Unexpected file field. Please upload the Excel file again.');
    } else {
      error = ApiError.badRequest(err.message || 'File upload failed');
    }
  }

  const statusCode = error.statusCode || 500;
  const response = {
    success: false,
    message: error.message || 'Internal Server Error',
  };

  if (error.errors && error.errors.length > 0) {
    response.errors = error.errors;
  }

  if (process.env.NODE_ENV === 'development' && statusCode === 500) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

// 404 handler
const notFound = (req, res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};

module.exports = { errorHandler, notFound };
