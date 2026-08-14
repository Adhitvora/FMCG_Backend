const Company = require('../models/company.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');
const { applyCompanyScope, assertCompanyAccess } = require('../utils/companyAccess');

// GET /api/companies
const getCompanies = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || paginationConfig.defaultPage;
    const limit = Math.min(parseInt(req.query.limit) || paginationConfig.defaultLimit, paginationConfig.maxLimit);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    applyCompanyScope(filter, req.user, '_id');
    if (req.query.search) {
      filter.$or = [
        { name: { $regex: req.query.search, $options: 'i' } },
        { gst: { $regex: req.query.search, $options: 'i' } },
      ];
    }

    const [companies, total] = await Promise.all([
      Company.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      Company.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, companies, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    next(error);
  }
};

// GET /api/companies/all - No pagination, for dropdowns
const getAllCompanies = async (req, res, next) => {
  try {
    const filter = { status: 'active' };
    if (req.query.search) filter.name = { $regex: req.query.search, $options: 'i' };
    applyCompanyScope(filter, req.user, '_id');
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const companies = await Company.find(filter).sort({ name: 1 }).select('name invoicePrefix').limit(limit);
    ApiResponse.success(res, companies);
  } catch (error) {
    next(error);
  }
};

// GET /api/companies/:id
const getCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company) throw ApiError.notFound('Company not found');
    assertCompanyAccess(req.user, company._id);
    ApiResponse.success(res, company);
  } catch (error) {
    next(error);
  }
};

// POST /api/companies
const createCompany = async (req, res, next) => {
  try {
    const { name, address, gst, contact, email, approvalDays, invoicePrefix } = req.body;

    const existing = await Company.findOne({ name: { $regex: `^${name}$`, $options: 'i' } });
    if (existing) throw ApiError.conflict('Company name already exists');

    const companyData = { name, address, gst, contact, email, approvalDays, invoicePrefix };

    // Handle logo upload
    if (req.file) {
      companyData.logo = req.file.cloudinaryUrl || `/uploads/logos/${req.file.filename}`;
    }

    const company = await Company.create(companyData);

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'CREATE', entity: 'Company', entityId: company._id,
      description: `Created company: ${name}`,
      newValue: companyData, ...clientInfo,
    });

    ApiResponse.created(res, company, 'Company created successfully');
  } catch (error) {
    next(error);
  }
};

// PUT /api/companies/:id
const updateCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company) throw ApiError.notFound('Company not found');

    const oldValue = company.toObject();
    const { name, address, gst, contact, email, approvalDays, invoicePrefix, status } = req.body;

    if (name && name !== company.name) {
      const existing = await Company.findOne({ name: { $regex: `^${name}$`, $options: 'i' }, _id: { $ne: company._id } });
      if (existing) throw ApiError.conflict('Company name already exists');
      company.name = name;
    }

    if (address !== undefined) company.address = address;
    if (gst !== undefined) company.gst = gst;
    if (contact !== undefined) company.contact = contact;
    if (email !== undefined) company.email = email;
    if (approvalDays !== undefined) company.approvalDays = approvalDays;
    if (invoicePrefix !== undefined) company.invoicePrefix = invoicePrefix;
    if (status !== undefined) company.status = status;

    if (req.file) {
      company.logo = req.file.cloudinaryUrl || `/uploads/logos/${req.file.filename}`;
    }

    await company.save();

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'UPDATE', entity: 'Company', entityId: company._id,
      description: `Updated company: ${company.name}`,
      oldValue, newValue: company.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, company, 'Company updated successfully');
  } catch (error) {
    next(error);
  }
};

// DELETE /api/companies/:id
const deleteCompany = async (req, res, next) => {
  try {
    const company = await Company.findById(req.params.id);
    if (!company) throw ApiError.notFound('Company not found');

    await Company.findByIdAndDelete(req.params.id);

    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id, username: req.user.username,
      action: 'DELETE', entity: 'Company', entityId: company._id,
      description: `Deleted company: ${company.name}`,
      oldValue: company.toObject(), ...clientInfo,
    });

    ApiResponse.success(res, null, 'Company deleted successfully');
  } catch (error) {
    next(error);
  }
};

module.exports = { getCompanies, getAllCompanies, getCompany, createCompany, updateCompany, deleteCompany };

