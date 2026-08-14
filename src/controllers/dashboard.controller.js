const Replacement = require('../models/replacement.model');
const Invoice = require('../models/invoice.model');
const MasterCarton = require('../models/masterCarton.model');
const Settlement = require('../models/settlement.model');
const ApiResponse = require('../utils/apiResponse');
const { applyCompanyScope } = require('../utils/companyAccess');

// GET /api/dashboard
const getDashboardStats = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const replacementBase = { status: 'active' };
    applyCompanyScope(replacementBase, req.user, 'company');
    const settlementBase = {};
    applyCompanyScope(settlementBase, req.user, 'companyId');

    const [
      todayReceived,
      todaySent,
      pendingApproval,
      pendingDispatch,
      pendingInvoice,
      totalReceived,
      totalSent,
      approvalAmountResult,
      pendingAmountResult,
      companyWise,
      monthlyStats,
      partyWise,
      topPendingParties,
      topPendingCompanies,
      settlementPending,
      settlementToday,
      settlementCompleted,
      partialSettlement,
      settlementOnHold,
      settlementApprovedValue,
      settlementSettledValue,
      settlementPendingValue,
    ] = await Promise.all([
      // Today's stats
      Replacement.countDocuments({ ...replacementBase, receivingDate: { $gte: today, $lt: tomorrow } }),
      Replacement.countDocuments({ ...replacementBase, sentDate: { $gte: today, $lt: tomorrow } }),
      Replacement.countDocuments({ ...replacementBase, approvalStatus: 'Pending' }),
      Replacement.countDocuments({ ...replacementBase, sentDate: null }),
      Replacement.countDocuments({ ...replacementBase, invoiceId: null }),

      // Totals
      Replacement.aggregate([{ $match: replacementBase }, { $group: { _id: null, total: { $sum: '$receivingCases' } } }]),
      Replacement.aggregate([{ $match: { ...replacementBase, sentDate: { $ne: null } } }, { $group: { _id: null, total: { $sum: '$dispatchCases' } } }]),
      Replacement.aggregate([{ $match: { ...replacementBase, approvalStatus: 'Approved' } }, { $group: { _id: null, total: { $sum: '$approvalAmount' } } }]),
      Replacement.aggregate([{ $match: { ...replacementBase, approvalStatus: 'Pending' } }, { $group: { _id: null, total: { $sum: '$approvalAmount' } } }]),

      // Company wise
      Replacement.aggregate([
        { $match: replacementBase },
        { $lookup: { from: 'companies', localField: 'company', foreignField: '_id', as: 'comp' } },
        { $unwind: '$comp' },
        { $group: { _id: '$company', name: { $first: '$comp.name' }, count: { $sum: 1 }, totalCases: { $sum: '$receivingCases' }, totalAmount: { $sum: '$approvalAmount' } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // Monthly (last 12 months)
      Replacement.aggregate([
        { $match: { ...replacementBase, receivingDate: { $gte: new Date(new Date().setMonth(new Date().getMonth() - 12)) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$receivingDate' } }, count: { $sum: 1 }, cases: { $sum: '$receivingCases' }, amount: { $sum: '$approvalAmount' } } },
        { $sort: { _id: 1 } },
      ]),

      // Party wise top 10
      Replacement.aggregate([
        { $match: replacementBase },
        { $lookup: { from: 'parties', localField: 'party', foreignField: '_id', as: 'pty' } },
        { $unwind: '$pty' },
        { $group: { _id: '$party', name: { $first: '$pty.name' }, town: { $first: '$pty.town' }, count: { $sum: 1 }, totalCases: { $sum: '$receivingCases' } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // Top pending parties
      Replacement.aggregate([
        { $match: { ...replacementBase, approvalStatus: 'Pending' } },
        { $lookup: { from: 'parties', localField: 'party', foreignField: '_id', as: 'pty' } },
        { $unwind: '$pty' },
        { $group: { _id: '$party', name: { $first: '$pty.name' }, town: { $first: '$pty.town' }, pendingCount: { $sum: 1 }, pendingCases: { $sum: '$receivingCases' } } },
        { $sort: { pendingCount: -1 } },
        { $limit: 5 },
      ]),

      // Top pending companies
      Replacement.aggregate([
        { $match: { ...replacementBase, approvalStatus: 'Pending' } },
        { $lookup: { from: 'companies', localField: 'company', foreignField: '_id', as: 'comp' } },
        { $unwind: '$comp' },
        { $group: { _id: '$company', name: { $first: '$comp.name' }, pendingCount: { $sum: 1 }, pendingAmount: { $sum: '$approvalAmount' } } },
        { $sort: { pendingCount: -1 } },
        { $limit: 5 },
      ]),
      Settlement.countDocuments({ ...settlementBase, settlementStatus: { $nin: ['SETTLED', 'REJECTED'] } }),
      Settlement.countDocuments({ ...settlementBase, completedAt: { $gte: today, $lt: tomorrow } }),
      Settlement.countDocuments({ ...settlementBase, settlementStatus: 'SETTLED' }),
      Settlement.countDocuments({ ...settlementBase, settlementStatus: 'PARTIAL' }),
      Settlement.countDocuments({ ...settlementBase, settlementStatus: 'ON_HOLD' }),
      Settlement.aggregate([{ $match: settlementBase }, { $group: { _id: null, total: { $sum: '$approvedValue' } } }]),
      Settlement.aggregate([{ $match: { ...settlementBase, settlementStatus: 'SETTLED' } }, { $group: { _id: null, total: { $sum: '$sentValue' } } }]),
      Settlement.aggregate([{ $match: { ...settlementBase, settlementStatus: { $nin: ['SETTLED', 'REJECTED'] } } }, { $group: { _id: null, total: { $sum: '$approvedValue' } } }]),
    ]);

    const stats = {
      today: { received: todayReceived, sent: todaySent },
      pending: { approval: pendingApproval, dispatch: pendingDispatch, invoice: pendingInvoice },
      totals: {
        casesReceived: totalReceived[0]?.total || 0,
        casesSent: totalSent[0]?.total || 0,
        approvalAmount: approvalAmountResult[0]?.total || 0,
        pendingAmount: pendingAmountResult[0]?.total || 0,
      },
      charts: { companyWise, monthlyStats, partyWise },
      topPending: { parties: topPendingParties, companies: topPendingCompanies },
      settlements: {
        pending: settlementPending,
        today: settlementToday,
        completed: settlementCompleted,
        partial: partialSettlement,
        onHold: settlementOnHold,
        totalApprovedValue: settlementApprovedValue[0]?.total || 0,
        totalSettledValue: settlementSettledValue[0]?.total || 0,
        pendingSettlementValue: settlementPendingValue[0]?.total || 0,
      },
    };

    ApiResponse.success(res, stats);
  } catch (error) {
    next(error);
  }
};

module.exports = { getDashboardStats };
