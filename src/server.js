require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const path = require('path');
const fs = require('fs');
const { connectDB } = require('./configs/db.config');
const { buildCorsOptions, getAllowedOrigins } = require('./configs/cors.config');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middlewares/error.middleware');
const dns = require("dns");
// Change DNS
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const app = express();
const PORT = process.env.PORT || 5000;
const uploadsRoot = path.join(__dirname, '..', 'uploads');
const frontendDistPath = process.env.FRONTEND_DIST_PATH
  ? path.resolve(process.env.FRONTEND_DIST_PATH)
  : path.resolve(__dirname, '..', '..', 'frontend', 'dist');
const frontendIndexPath = path.join(frontendDistPath, 'index.html');

for (const directory of [uploadsRoot, path.join(uploadsRoot, 'invoices'), path.join(uploadsRoot, 'temp')]) {
  fs.mkdirSync(directory, { recursive: true });
}

// Connect to MongoDB
connectDB();

// Security Middleware
app.use(helmet());
const corsOptions = buildCorsOptions();
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(mongoSanitize());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api', limiter);

// Stricter rate limit for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many login attempts, please try again later.' },
});
app.use('/api/auth/login', authLimiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Static files - uploads
app.use('/uploads', express.static(uploadsRoot));

// API Routes
app.use('/api', routes);

// Static files - React production build
if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendDistPath));

  app.use((req, res, next) => {
    const isNavigationRequest =
      (req.method === 'GET' || req.method === 'HEAD') &&
      req.accepts('html') &&
      !path.extname(req.path);
    const isApiRequest = req.path === '/api' || req.path.startsWith('/api/');
    const isUploadRequest = req.path === '/uploads' || req.path.startsWith('/uploads/');

    if (!isNavigationRequest || isApiRequest || isUploadRequest) {
      return next();
    }

    return res.sendFile(frontendIndexPath);
  });
}

// Error handling
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  const allowedOrigins = getAllowedOrigins();
  console.log(`CORS allowed origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : 'none configured'}`);
  console.log(`🚀 Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});

module.exports = app;
