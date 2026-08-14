module.exports = {
  jwt: {
    secret: process.env.JWT_SECRET || 'default_jwt_secret',
    expire: process.env.JWT_EXPIRE || '1d',
    refreshExpire: process.env.JWT_REFRESH_EXPIRE || '7d',
  },
  upload: {
    path: process.env.UPLOAD_PATH || './uploads',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB
    allowedImageTypes: ['image/jpeg', 'image/png', 'image/webp'],
    allowedDocTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
  },
  pagination: {
    defaultPage: 1,
    defaultLimit: 20,
    maxLimit: 100,
  },
  roles: {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    OPERATOR: 'operator',
    VIEW_ONLY: 'view_only',
  },
  approvalStatuses: {
    PENDING: 'Pending',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    PARTIAL: 'Partial',
  },
  invoiceStatuses: {
    ACTIVE: 'Active',
    CANCELLED: 'Cancelled',
  },
};
