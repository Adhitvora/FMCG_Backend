const { verifyToken } = require('../helpers/token.helper');
const User = require('../models/user.model');
const ApiError = require('../utils/apiError');

const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : null;
    const token = bearerToken || req.query.token;

    if (!token) {
      throw ApiError.unauthorized('Access token is required');
    }

    const decoded = verifyToken(token);

    const user = await User.findById(decoded.id);
    if (!user) {
      throw ApiError.unauthorized('User not found');
    }

    if (user.status === 'disabled') {
      throw ApiError.forbidden('Your account has been disabled. Contact Super Admin.');
    }

    req.user = {
      id: user._id,
      username: user.username,
      role: user.role,
      branch: user.branch,
      company: user.company || null,
      companies: Array.isArray(user.companies) ? user.companies : [],
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return next(ApiError.unauthorized('Invalid token'));
    }
    if (error.name === 'TokenExpiredError') {
      return next(ApiError.unauthorized('Token expired'));
    }
    next(error);
  }
};

module.exports = auth;

