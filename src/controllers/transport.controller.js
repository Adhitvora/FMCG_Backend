const Transport = require('../models/transport.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');

// GET /api/transports
const getTransports = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || paginationConfig.defaultPage;
    const limit = Math.min(parseInt(req.query.limit) || paginationConfig.defaultLimit, paginationConfig.maxLimit);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { contact: { $regex: req.query.search, $options: 'i' } },
      ];
    }

    const [transports, total] = await Promise.all([
      Transport.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      Transport.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, transports, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
};

// GET /api/transports/all - For dropdowns
const getAllTransports = async (req, res, next) => {
  try {
    const filter = { status: 'active' };
    if (req.query.search) filter.name = { $regex: req.query.search, $options: 'i' };
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const transports = await Transport.find(filter).sort({ name: 1 }).select('name').limit(limit);
    ApiResponse.success(res, transports);
  } catch (error) {
    next(error);
  }
};

// GET /api/transports/:id
const getTransport = async (req, res, next) => {
  try {
    const transport = await Transport.findById(req.params.id);
    if (!transport) throw ApiError.notFound('Transport not found');
    ApiResponse.success(res, transport);
  } catch (error) {
    next(error);
  }
};

// POST /api/transports
const createTransport = async (req, res, next) => {
  try {
    const { name, contact, gst, branch } = req.body;

    const existing = await Transport.findOne({ name: { $regex: `^${name.trim()}$`, $options: 'i' } });
    if (existing) throw ApiError.conflict('Transport name already exists');

    const transport = await Transport.create({ name, contact, gst, branch });

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'CREATE', entity: 'Transport', entityId: transport._id,
      description: `Created transport: ${name}`,
      newValue: { name, contact, gst, branch }, ...clientInfo,
    });

    ApiResponse.created(res, transport, 'Transport created successfully');
  } catch (error) {
    next(error);
  }
};

// PUT /api/transports/:id
const updateTransport = async (req, res, next) => {
  try {
    const transport = await Transport.findById(req.params.id);
    if (!transport) throw ApiError.notFound('Transport not found');

    const oldValue = transport.toObject();
    const { name, contact, gst, branch, status } = req.body;

    if (name && name !== transport.name) {
      const existing = await Transport.findOne({ name: { $regex: `^${name.trim()}$`, $options: 'i' }, _id: { $ne: transport._id } });
      if (existing) throw ApiError.conflict('Transport name already exists');
      transport.name = name;
    }

    if (contact !== undefined) transport.contact = contact;
    if (gst !== undefined) transport.gst = gst;
    if (branch !== undefined) transport.branch = branch;
    if (status !== undefined) transport.status = status;

    await transport.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'UPDATE', entity: 'Transport', entityId: transport._id,
      description: `Updated transport: ${transport.name}`,
      oldValue, newValue: transport.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, transport, 'Transport updated successfully');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/transports/:id
const deleteTransport = async (req, res, next) => {
  try {
    const transport = await Transport.findById(req.params.id);
    if (!transport) throw ApiError.notFound('Transport not found');

    await Transport.findByIdAndDelete(req.params.id);

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'DELETE', entity: 'Transport', entityId: transport._id,
      description: `Deleted transport: ${transport.name}`,
      oldValue: transport.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, null, 'Transport deleted successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = { getTransports, getAllTransports, getTransport, createTransport, updateTransport, deleteTransport };

