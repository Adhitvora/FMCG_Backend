const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_HEADERS = ['Content-Type', 'Authorization'];

const splitOrigins = (value = '') => String(value)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const getAllowedOrigins = () => {
  const configured = [
    ...splitOrigins(process.env.FRONTEND_URLS),
    ...splitOrigins(process.env.FRONTEND_URL),
    ...splitOrigins(process.env.CORS_ORIGIN),
  ];

  return [...new Set(configured)];
};

const buildCorsOptions = () => {
  const allowedOrigins = getAllowedOrigins();

  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: DEFAULT_METHODS,
    allowedHeaders: DEFAULT_HEADERS,
    optionsSuccessStatus: 204,
  };
};

module.exports = {
  buildCorsOptions,
  getAllowedOrigins,
};
