const User = require('../models/user.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');

// GET /api/users
const getUsers = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || paginationConfig.defaultPage;
    const limit = Math.min(
      parseInt(req.query.limit) || paginationConfig.defaultLimit,
      paginationConfig.maxLimit
    );
    const skip = (page - 1) * limit;

    // Build filter
    const filter = {};
    if (req.query.role) filter.role = req.query.role;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      filter.username = { $regex: req.query.search, $options: 'i' };
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .populate('createdBy', 'username')
        .populate('company', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, users, {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/users/:id
const getUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).populate('createdBy', 'username')
        .populate('company', 'name')
        .populate('companies', 'name');
    if (!user) {
      throw ApiError.notFound('User not found');
    }
    ApiResponse.success(res, user);
  } catch (error) {
    next(error);
  }
};

// POST /api/users
const createUser = async (req, res, next) => {
  try {
    const { username, password, role, branch, company, companies } = req.body;

    // Check duplicate
    const existing = await User.findOne({ username });
    if (existing) {
      throw ApiError.conflict('Username already exists');
    }

    const user = await User.create({
      username,
      password,
      role,
      branch,
      createdBy: req.user.id,
    });

    // Audit log
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'CREATE',
      entity: 'User',
      entityId: user._id,
      description: `Created user: ${username} with role: ${role}`,
      newValue: { username, role, branch, company, companies },
      ...clientInfo,
    });

    ApiResponse.created(res, user, 'User created successfully');
  } catch (error) {
    next(error);
  }
};

// PUT /api/users/:id
const updateUser = async (req, res, next) => {
  try {
    const { username, role, branch, company, companies } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    const oldValue = { username: user.username, role: user.role, branch: user.branch, company: user.company, companies: user.companies };

    // Check duplicate username if changed
    if (username && username !== user.username) {
      const existing = await User.findOne({ username });
      if (existing) {
        throw ApiError.conflict('Username already exists');
      }
      user.username = username;
    }

    if (role) user.role = role;
    if (branch !== undefined) user.branch = branch;
    if (company !== undefined) user.company = company || null;
    if (companies !== undefined) user.companies = Array.isArray(companies) ? companies : [];

    await user.save();

    // Audit log
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'UPDATE',
      entity: 'User',
      entityId: user._id,
      description: `Updated user: ${user.username}`,
      oldValue,
      newValue: { username: user.username, role: user.role, branch: user.branch, company: user.company, companies: user.companies },
      ...clientInfo,
    });

    ApiResponse.success(res, user, 'User updated successfully');
  } catch (error) {
    next(error);
  }
};

// PUT /api/users/:id/reset-password
const resetPassword = async (req, res, next) => {
  try {
    const { newPassword } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    user.password = newPassword;
    await user.save();

    // Audit log
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'PASSWORD_RESET',
      entity: 'User',
      entityId: user._id,
      description: `Password reset for user: ${user.username}`,
      ...clientInfo,
    });

    ApiResponse.success(res, null, 'Password reset successfully');
  } catch (error) {
    next(error);
  }
};

// PUT /api/users/:id/toggle-status
const toggleStatus = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    // Prevent disabling yourself
    if (user._id.toString() === req.user.id) {
      throw ApiError.badRequest('You cannot disable your own account');
    }

    const oldStatus = user.status;
    user.status = user.status === 'active' ? 'disabled' : 'active';
    await user.save();

    // Audit log
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'STATUS_CHANGE',
      entity: 'User',
      entityId: user._id,
      description: `User ${user.username} status changed from ${oldStatus} to ${user.status}`,
      oldValue: { status: oldStatus },
      newValue: { status: user.status },
      ...clientInfo,
    });

    ApiResponse.success(
      res,
      user,
      `User ${user.status === 'active' ? 'enabled' : 'disabled'} successfully`
    );
  } catch (error) {
    next(error);
  }
};

// DELETE /api/users/:id
const deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    // Prevent deleting yourself
    if (user._id.toString() === req.user.id) {
      throw ApiError.badRequest('You cannot delete your own account');
    }

    await User.findByIdAndDelete(req.params.id);

    // Audit log
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'DELETE',
      entity: 'User',
      entityId: user._id,
      description: `Deleted user: ${user.username}`,
      oldValue: { username: user.username, role: user.role },
      ...clientInfo,
    });

    ApiResponse.success(res, null, 'User deleted successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUsers,
  getUser,
  createUser,
  updateUser,
  resetPassword,
  toggleStatus,
  deleteUser,
};

