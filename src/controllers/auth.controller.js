const User = require('../models/user.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { generateAccessToken, generateRefreshToken, verifyToken } = require('../helpers/token.helper');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');

// POST /api/auth/login
const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    // Find user with password field
    const user = await User.findOne({ username }).select('+password');
    if (!user) {
      throw ApiError.unauthorized('Invalid username or password');
    }

    if (user.status === 'disabled') {
      throw ApiError.forbidden('Your account has been disabled. Contact Super Admin.');
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw ApiError.unauthorized('Invalid username or password');
    }

    // Generate tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Save refresh token and update last login
    user.refreshToken = refreshToken;
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    // Audit log
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: user._id,
      username: user.username,
      action: 'LOGIN',
      entity: 'User',
      entityId: user._id,
      description: `User ${user.username} logged in`,
      ...clientInfo,
    });

    ApiResponse.success(res, {
      user: {
        id: user._id,
        username: user.username,
        role: user.role,
        branch: user.branch,
      },
      accessToken,
      refreshToken,
    }, 'Login successful');
  } catch (error) {
    next(error);
  }
};

// POST /api/auth/refresh
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      throw ApiError.unauthorized('Refresh token is required');
    }

    // Verify refresh token
    const decoded = verifyToken(token);

    // Find user with refresh token
    const user = await User.findById(decoded.id).select('+refreshToken');
    if (!user || user.refreshToken !== token) {
      throw ApiError.unauthorized('Invalid refresh token');
    }

    if (user.status === 'disabled') {
      throw ApiError.forbidden('Your account has been disabled');
    }

    // Generate new tokens
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    // Save new refresh token
    user.refreshToken = newRefreshToken;
    await user.save({ validateBeforeSave: false });

    ApiResponse.success(res, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    }, 'Token refreshed');
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return next(ApiError.unauthorized('Invalid or expired refresh token'));
    }
    next(error);
  }
};

// POST /api/auth/logout
const logout = async (req, res, next) => {
  try {
    // Clear refresh token
    await User.findByIdAndUpdate(req.user.id, { refreshToken: null });

    // Audit log
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'LOGOUT',
      entity: 'User',
      entityId: req.user.id,
      description: `User ${req.user.username} logged out`,
      ...clientInfo,
    });

    ApiResponse.success(res, null, 'Logged out successfully');
  } catch (error) {
    next(error);
  }
};

// GET /api/auth/me
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      throw ApiError.notFound('User not found');
    }
    ApiResponse.success(res, user);
  } catch (error) {
    next(error);
  }
};

module.exports = { login, refreshToken, logout, getMe };
