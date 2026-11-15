const fs = require('fs');
const mongoose = require('mongoose');
const Invoice = require('../models/invoice.model');
const Replacement = require('../models/replacement.model');
const Company = require('../models/company.model');
const Transport = require('../models/transport.model');
const MasterCarton = require('../models/masterCarton.model');
const Counter = require('../models/counter.model');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { createAuditLog, getClientInfo } = require('../middlewares/audit.middleware');
const { pagination: paginationConfig } = require('../configs/app.config');
const { INVOICE_PDF_VERSION, buildInvoiceData, caseQuantity, hydrateInvoiceCartons, idOf, snapshotCarton } = require('../services/invoiceData.service');
const { applyCompanyScope, assertCompanyAccess } = require('../utils/companyAccess');
const { isReplicaSet } = require('../configs/db.config');
const {
  createTempPdfPath,
  ensureInvoiceDirectories,
  fileExists,
  getInvoicePdfInfo,
  removeFileIfExists,
  renderInvoicePdf,
  renderInvoiceHtml,
  uploadInvoicePdfToCloudinary,
} = require('../services/invoicePdf.service');

const generateInvoiceNumber = async (prefix, session) => {
  const year = new Date().getFullYear();
  const sequence = await Counter.getNextSequence('invoice_' + year, session);
  return String(prefix || 'HAE') + '-' + year + '-' + String(sequence).padStart(6, '0');
};

const runWithOptionalTransaction = async (fn) => {
  if (!isReplicaSet()) return fn(null);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
};

const sessionOpt = (session) => (session ? { session } : {});
const withSession = (query, session) => (session ? query.session(session) : query);

const getInvoices = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || paginationConfig.defaultPage, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || paginationConfig.defaultLimit, 1), paginationConfig.maxLimit);
    const filter = {};

    if (req.query.status) filter.status = req.query.status;
    if (req.query.company) filter.company = req.query.company;
    applyCompanyScope(filter, req.user, 'company');
    if (req.query.search) {
      filter.$or = [
        { invoiceNumber: { $regex: req.query.search, $options: 'i' } },
        { companyName: { $regex: req.query.search, $options: 'i' } },
        { transportName: { $regex: req.query.search, $options: 'i' } },
        { lrNo: { $regex: req.query.search, $options: 'i' } },
        { 'items.partyName': { $regex: req.query.search, $options: 'i' } },
        { 'items.town': { $regex: req.query.search, $options: 'i' } },
      ];
    }
    if (req.query.dateFrom || req.query.dateTo) {
      filter.invoiceDate = {};
      if (req.query.dateFrom) filter.invoiceDate.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) filter.invoiceDate.$lte = new Date(req.query.dateTo + 'T23:59:59');
    }

    const skip = (page - 1) * limit;
    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .populate('company', 'name')
        .populate('transport', 'name')
        .populate('createdBy', 'username')
        .sort({ invoiceDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Invoice.countDocuments(filter),
    ]);

    ApiResponse.paginated(res, invoices, { page, limit, total, pages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
};

const getInvoice = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('company', 'name address gst contact email')
      .populate('transport', 'name')
      .populate('items.party', 'name town gst')
      .populate('createdBy', 'username');
    if (!invoice) throw ApiError.notFound('Invoice not found');
    assertCompanyAccess(req.user, invoice.company?._id || invoice.company);
    await hydrateInvoiceCartons(invoice);
    ApiResponse.success(res, invoice);
  } catch (error) { next(error); }
};

const getInvoiceHtml = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id).populate('company', 'name address gst contact email');
    if (!invoice) throw ApiError.notFound('Invoice not found');
    assertCompanyAccess(req.user, invoice.company?._id || invoice.company);
    await hydrateInvoiceCartons(invoice);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(await renderInvoiceHtml(invoice.toObject()));
  } catch (error) { next(error); }
};

const createInvoice = async (req, res, next) => {
  const { company, replacementIds, remarks, invoiceDate, transport, lrNo, dispatchDate } = req.body;
  const replacementIdList = Array.isArray(replacementIds) ? [...new Set(replacementIds.map((id) => String(id)))] : [];
  let tempPdfPath = '';
  let finalPdfPath = '';
  let committed = false;

  try {
    if (!company) throw ApiError.badRequest('Company is required');
    if (!['super_admin', 'admin'].includes(req.user.role)) throw ApiError.forbidden('You do not have permission to create invoices or merge cartons');
    assertCompanyAccess(req.user, company);
    if (replacementIdList.length === 0) throw ApiError.badRequest('At least one replacement is required');
    await ensureInvoiceDirectories();

    const createdInvoice = await runWithOptionalTransaction(async (session) => {
      const companyDoc = await withSession(Company.findById(company), session);
      if (!companyDoc) throw ApiError.notFound('Company not found');

      let transportDoc = null;
      let transportName = '';
      if (transport) {
        transportDoc = await withSession(Transport.findById(transport), session);
        if (!transportDoc) throw ApiError.notFound('Transport not found');
        transportName = transportDoc.name;
      }

      const replacements = await withSession(
        Replacement.find({ _id: { $in: replacementIdList }, company: companyDoc._id, invoiceId: null, status: 'active' }).populate('party', 'name town'),
        session,
      );
      if (replacements.length !== replacementIdList.length) throw ApiError.conflict('One or more replacements are unavailable or already invoiced');
      replacements.forEach((rep) => caseQuantity(rep.receivingCases, 'Received cases'));
      if (req.user.role !== 'super_admin' && replacements.some((rep) => rep.isDispatchLocked)) {
        throw ApiError.forbidden('One or more approved dispatch records are locked. Only Super Admin can correct invoice mapping.');
      }

      const now = new Date();
      const actualDispatchDate = dispatchDate ? new Date(dispatchDate) : now;
      if (Number.isNaN(actualDispatchDate.getTime()) || (invoiceDate && Number.isNaN(new Date(invoiceDate).getTime()))) {
        throw ApiError.badRequest('Invoice and dispatch dates must be valid dates');
      }
      const unassigned = replacements.filter((rep) => !rep.cartonId && !rep.masterCartonId);
      if (unassigned.some((rep) => rep.cartonMergedAt || rep.cartonStatus === 'MERGED')) {
        throw ApiError.conflict('A previously merged carton relationship is missing. Restore the relationship before invoicing.');
      }
      const existingCartonIds = [...new Set(replacements.map((rep) => idOf(rep.cartonId || rep.masterCartonId)).filter(Boolean))];
      const relatedCartons = await withSession(MasterCarton.find({
        $or: [{ _id: { $in: existingCartonIds } }, { 'entries.replacementId': { $in: replacementIdList } }],
      }), session);
      const cartonById = new Map(relatedCartons.map((carton) => [idOf(carton._id), carton]));
      for (const carton of relatedCartons) {
        if (idOf(carton.company) !== idOf(companyDoc._id)) throw ApiError.conflict('Selected cartons belong to another company');
        const selected = new Set(replacementIdList);
        if (carton.entries.some((entry) => !selected.has(idOf(entry.replacementId)))) {
          throw ApiError.conflict('Select every replacement in a merged carton together. A merged carton cannot be split between invoices.');
        }
        for (const entry of carton.entries) {
          const rep = replacements.find((candidate) => idOf(candidate._id) === idOf(entry.replacementId));
          if (!rep || idOf(rep.cartonId || rep.masterCartonId) !== idOf(carton._id)) {
            throw ApiError.conflict('The saved carton membership is inconsistent. Restore the relationship before invoicing.');
          }
        }
      }
      if (existingCartonIds.some((id) => !cartonById.has(id))) throw ApiError.conflict('A saved carton relationship is missing');
      for (const rep of replacements) {
        if (rep.cartonId && rep.masterCartonId && idOf(rep.cartonId) !== idOf(rep.masterCartonId)) {
          throw ApiError.conflict('The saved carton membership is inconsistent');
        }
      }
      const orderedReplacements = replacementIdList.map((id) => replacements.find((rep) => String(rep._id) === id));
      const groupKeys = [...new Set(orderedReplacements.map((rep) => idOf(rep.cartonId || rep.masterCartonId || rep._id)))];
      const groupDisplay = new Map(groupKeys.map((key, index) => [key, index + 1]));
      const items = orderedReplacements.map((rep) => {
        const cartonId = rep.cartonId || rep.masterCartonId || null;
        const key = String(cartonId || rep._id);
        const displayValue = groupDisplay.get(key);
        return {
          replacement: rep._id,
          replacementId: rep.replacementId,
          party: rep.party?._id || rep.party,
          partyName: rep.party?.name || '',
          town: rep.town || rep.party?.town || '',
          lrNo: rep.receivingLRNo || '',
          actualCases: Number(rep.receivingCases),
          cartonLabel: '',
          masterCartonNumber: '',
          cartonId,
          cartonGroupNumber: rep.cartonGroupNumber || displayValue,
          cartonDisplayValue: displayValue,
          receivingDate: rep.receivingDate,
          receivingCases: rep.receivingCases,
          sentDate: rep.sentDate || actualDispatchDate,
          dispatchCases: rep.dispatchCases || rep.receivingCases,
          approvalStatus: rep.approvalStatus,
          approvalAmount: rep.approvalAmount,
          approvedCases: rep.approvedCases,
          rejectedCases: rep.rejectedCases,
          companyReference: rep.companyReference,
        };
      });

      const invoiceNumber = await generateInvoiceNumber(companyDoc.invoicePrefix, session);
      const invoice = new Invoice({
        invoiceNumber,
        invoiceDate: invoiceDate || now,
        company: companyDoc._id,
        companyName: companyDoc.name,
        companySnapshot: { name: companyDoc.name, address: companyDoc.address, gst: companyDoc.gst, contact: companyDoc.contact, email: companyDoc.email },
        transport: transportDoc?._id || null,
        transportName,
        lrNo: lrNo || '',
        dispatchDate: actualDispatchDate,
        cartons: [...cartonById.values()].map(snapshotCarton),
        items,
        remarks,
        isLocked: true,
        lockedAt: now,
        lockedBy: req.user.id,
        createdBy: req.user.id,
      });
      const normalized = buildInvoiceData(invoice);
      invoice.totalActualCases = normalized.totalCase1;
      invoice.totalCase2 = normalized.totalCase2;
      const claimed = [];
      try {
        // Validate and render the complete group layout before reserving invoice rows.
        tempPdfPath = createTempPdfPath(invoiceNumber);
        await renderInvoicePdf(invoice.toObject(), tempPdfPath);
        for (const rep of orderedReplacements) {
          const previous = {
            invoiceId: null, invoiceNumber: '', invoiceDate: null,
            cartonStatus: rep.cartonStatus,
            sentDate: rep.sentDate || null,
            dispatchTransport: rep.dispatchTransport || null,
            dispatchLRNo: rep.dispatchLRNo || '',
            dispatchCases: rep.dispatchCases || 0,
            dispatchCartons: rep.dispatchCartons || 0,
          };
          // Track ownership before awaiting: a network error can follow an
          // applied write whose acknowledgement was lost.
          claimed.push({ rep, previous });
          const result = await Replacement.updateOne({
            _id: rep._id, company: companyDoc._id, invoiceId: null, status: 'active',
            cartonId: rep.cartonId || null, masterCartonId: rep.masterCartonId || null,
            receivingCases: rep.receivingCases, cartonMergedAt: rep.cartonMergedAt || null,
            party: rep.party?._id || rep.party, town: rep.town,
            receivingLRNo: rep.receivingLRNo,
            isDispatchLocked: req.user.role === 'super_admin' ? rep.isDispatchLocked : false,
          }, { $set: {
            invoiceId: invoice._id, invoiceNumber, invoiceDate: invoice.invoiceDate,
            cartonStatus: 'DISPATCHED', sentDate: rep.sentDate || actualDispatchDate,
            dispatchTransport: rep.dispatchTransport || transportDoc?._id || null,
            dispatchLRNo: rep.dispatchLRNo || lrNo || '',
            dispatchCases: rep.dispatchCases || rep.receivingCases,
            dispatchCartons: rep.dispatchCartons || (rep.cartonId || rep.masterCartonId ? 1 : rep.receivingCases),
          } }, sessionOpt(session));
          if (result.modifiedCount !== 1) throw ApiError.conflict('Replacement records changed while the invoice was being created. Reload and try again.');
        }
        await invoice.save(sessionOpt(session));
        const pdfInfo = getInvoicePdfInfo(invoiceNumber);
        await fs.promises.rename(tempPdfPath, pdfInfo.absolutePath);
        tempPdfPath = '';
        finalPdfPath = pdfInfo.absolutePath;
        const cloudinaryUrl = await uploadInvoicePdfToCloudinary(pdfInfo.absolutePath, invoiceNumber);
        invoice.pdfPath = cloudinaryUrl || pdfInfo.publicPath;
        invoice.pdfGeneratedAt = new Date();
        invoice.pdfVersion = INVOICE_PDF_VERSION;
        await invoice.save(sessionOpt(session));
        if (cartonById.size) await MasterCarton.updateMany(
          { _id: { $in: [...cartonById.keys()] }, company: companyDoc._id },
          { $set: { status: 'Dispatched' } }, sessionOpt(session),
        );
        return invoice;
      } catch (error) {
        if (!session) {
          // Standalone MongoDB has no transactions: undo only this invoice's claims.
          // Successfully created carton relationships remain permanent.
          for (const { rep, previous } of claimed) {
            await Replacement.updateOne({ _id: rep._id, invoiceId: invoice._id }, { $set: previous });
          }
          await Invoice.deleteOne({ _id: invoice._id });
        }
        throw error;
      }
    });
    committed = true;

    const savedInvoice = await Invoice.findById(createdInvoice._id).populate('company', 'name address gst contact email').populate('transport', 'name').populate('items.party', 'name town');
    const clientInfo = getClientInfo(req);
    await createAuditLog({
      userId: req.user.id,
      username: req.user.username,
      action: 'INVOICE_GENERATED',
      entity: 'Invoice',
      entityId: savedInvoice._id,
      description: 'Created invoice ' + savedInvoice.invoiceNumber + ' with ' + savedInvoice.items.length + ' items',
      newValue: { invoiceNumber: savedInvoice.invoiceNumber, totalActualCases: savedInvoice.totalActualCases, totalCase2: savedInvoice.totalCase2, itemCount: savedInvoice.items.length, pdfPath: savedInvoice.pdfPath },
      ...clientInfo,
    });
    ApiResponse.created(res, savedInvoice, 'Invoice and PDF created successfully');
  } catch (error) {
    await removeFileIfExists(tempPdfPath).catch(() => {});
    if (!committed) await removeFileIfExists(finalPdfPath).catch(() => {});
    next(error);
  }
};

const findInvoiceForPdf = (invoiceId) => Invoice.findById(invoiceId).populate('company', 'name address gst contact email');

const regenerateStoredPdf = async (invoice) => {
  await hydrateInvoiceCartons(invoice);
  await ensureInvoiceDirectories();
  const pdfInfo = getInvoicePdfInfo(invoice.invoiceNumber);
  const tempPdfPath = createTempPdfPath(invoice.invoiceNumber);
  const backupPath = pdfInfo.absolutePath + '.backup-' + Date.now();
  const hadExistingPdf = await fileExists(pdfInfo.absolutePath);
  let backedUp = false;
  let installed = false;
  try {
    await renderInvoicePdf(invoice.toObject(), tempPdfPath);
    if (hadExistingPdf) {
      await fs.promises.rename(pdfInfo.absolutePath, backupPath);
      backedUp = true;
    }
    await fs.promises.rename(tempPdfPath, pdfInfo.absolutePath);
    installed = true;
    invoice.pdfPath = pdfInfo.publicPath;
    invoice.pdfGeneratedAt = new Date();
    invoice.pdfVersion = INVOICE_PDF_VERSION;
    await invoice.save();
    if (hadExistingPdf) await removeFileIfExists(backupPath);
    return pdfInfo;
  } catch (error) {
    await removeFileIfExists(tempPdfPath).catch(() => {});
    if (installed) await removeFileIfExists(pdfInfo.absolutePath).catch(() => {});
    if (backedUp && await fileExists(backupPath)) await fs.promises.rename(backupPath, pdfInfo.absolutePath).catch(() => {});
    throw error;
  }
};

const getInvoicePDF = async (req, res, next) => {
  try {
    const invoice = await findInvoiceForPdf(req.params.id);
    if (!invoice) throw ApiError.notFound('Invoice not found');
    assertCompanyAccess(req.user, invoice.company?._id || invoice.company);
    const pdfInfo = getInvoicePdfInfo(invoice.invoiceNumber);
    if (invoice.pdfVersion !== INVOICE_PDF_VERSION || !invoice.pdfPath || !await fileExists(pdfInfo.absolutePath)) await regenerateStoredPdf(invoice);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + pdfInfo.fileName + '"');
    res.sendFile(pdfInfo.absolutePath, (error) => { if (error) next(error); });
  } catch (error) { next(error); }
};

const reprintInvoice = async (req, res, next) => {
  try {
    const invoice = await findInvoiceForPdf(req.params.id);
    if (!invoice) throw ApiError.notFound('Invoice not found');
    assertCompanyAccess(req.user, invoice.company?._id || invoice.company);
    await regenerateStoredPdf(invoice);
    const clientInfo = getClientInfo(req);
    await createAuditLog({ userId: req.user.id, username: req.user.username, action: 'INVOICE_REGENERATED', entity: 'Invoice', entityId: invoice._id, description: 'Regenerated PDF for invoice ' + invoice.invoiceNumber, newValue: { pdfPath: invoice.pdfPath }, ...clientInfo });
    ApiResponse.success(res, invoice, 'Invoice PDF regenerated successfully');
  } catch (error) { next(error); }
};

const trackPrint = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) throw ApiError.notFound('Invoice not found');
    assertCompanyAccess(req.user, invoice.company);
    invoice.printHistory.push({ printedBy: req.user.id, username: req.user.username, printedAt: new Date() });
    invoice.printCount = (invoice.printCount || 0) + 1;
    await invoice.save();
    const clientInfo = getClientInfo(req);
    await createAuditLog({ userId: req.user.id, username: req.user.username, action: 'INVOICE_PRINTED', entity: 'Invoice', entityId: invoice._id, description: 'Printed invoice ' + invoice.invoiceNumber, newValue: { printCount: invoice.printCount }, ...clientInfo });
    ApiResponse.success(res, { printCount: invoice.printCount, lastPrintedAt: invoice.printHistory[invoice.printHistory.length - 1].printedAt }, 'Print recorded');
  } catch (error) { next(error); }
};

const unlockInvoice = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) throw ApiError.notFound('Invoice not found');
    assertCompanyAccess(req.user, invoice.company);
    invoice.isLocked = false;
    await invoice.save();
    const clientInfo = getClientInfo(req);
    await createAuditLog({ userId: req.user.id, username: req.user.username, action: 'UPDATE', entity: 'Invoice', entityId: invoice._id, description: 'Unlocked invoice ' + invoice.invoiceNumber, oldValue: { isLocked: true }, newValue: { isLocked: false }, ...clientInfo });
    ApiResponse.success(res, invoice, 'Invoice unlocked');
  } catch (error) { next(error); }
};

const cancelInvoice = async (req, res, next) => {
  try {
    const cancelledInvoice = await runWithOptionalTransaction(async (session) => {
      const invoice = await withSession(Invoice.findById(req.params.id), session);
      if (!invoice) throw ApiError.notFound('Invoice not found');
      assertCompanyAccess(req.user, invoice.company);
      if (invoice.status === 'Cancelled') throw ApiError.badRequest('Invoice is already cancelled');
      invoice.status = 'Cancelled';
      invoice.cancelledReason = req.body.reason || 'Cancelled by user';
      invoice.cancelledDate = new Date();
      invoice.cancelledBy = req.user.id;
      await invoice.save(sessionOpt(session));
      await Replacement.updateMany(
        { invoiceId: invoice._id, cartonId: null, masterCartonId: null },
        { $set: { invoiceId: null, invoiceNumber: '', invoiceDate: null, cartonStatus: 'AVAILABLE' } }, sessionOpt(session),
      );
      await Replacement.updateMany(
        { invoiceId: invoice._id },
        { $set: { invoiceId: null, invoiceNumber: '', invoiceDate: null, cartonStatus: 'MERGED' } }, sessionOpt(session),
      );
      return invoice;
    });
    const clientInfo = getClientInfo(req);
    await createAuditLog({ userId: req.user.id, username: req.user.username, action: 'CANCEL', entity: 'Invoice', entityId: cancelledInvoice._id, description: 'Cancelled invoice ' + cancelledInvoice.invoiceNumber, oldValue: { status: 'Active' }, newValue: { status: 'Cancelled', reason: cancelledInvoice.cancelledReason }, ...clientInfo });
    ApiResponse.success(res, cancelledInvoice, 'Invoice cancelled');
  } catch (error) { next(error); }
};

module.exports = {
  cancelInvoice,
  createInvoice,
  getInvoice,
  getInvoiceHtml,
  getInvoicePDF,
  getInvoices,
  reprintInvoice,
  trackPrint,
  unlockInvoice,
};
