const Replacement = require('../models/replacement.model');
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
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

    const replacementBase = { status: 'active' };
    applyCompanyScope(replacementBase, req.user, 'company');
    const settlementBase = {};
    applyCompanyScope(settlementBase, req.user, 'companyId');

    // Combine all replacement counts + totals into ONE aggregation using $facet
    const [replacementFacet, settlementFacet, companyWise, monthlyStats, partyWise, topPendingParties, topPendingCompanies] = await Promise.all([
      // Single replacement aggregation with $facet
      Replacement.aggregate([
        { $match: replacementBase },
        {
          $facet: {
            todayReceived: [
              { $match: { receivingDate: { $gte: today, $lt: tomorrow } } },
              { $count: 'count' },
            ],
            todaySent: [
              { $match: { sentDate: { $gte: today, $lt: tomorrow } } },
              { $count: 'count' },
            ],
            pendingApproval: [
              { $match: { approvalStatus: 'Pending' } },
              { $count: 'count' },
            ],
            pendingDispatch: [
              { $match: { sentDate: null } },
              { $count: 'count' },
            ],
            pendingInvoice: [
              { $match: { invoiceId: null } },
              { $count: 'count' },
            ],
            totalCasesReceived: [
              { $group: { _id: null, total: { $sum: '$receivingCases' } } },
            ],
            totalCasesSent: [
              { $match: { sentDate: { $ne: null } } },
              { $group: { _id: null, total: { $sum: '$dispatchCases' } } },
            ],
            approvalAmount: [
              { $match: { approvalStatus: 'Approved' } },
              { $group: { _id: null, total: { $sum: '$approvalAmount' } } },
            ],
            pendingAmount: [
              { $match: { approvalStatus: 'Pending' } },
              { $group: { _id: null, total: { $sum: '$approvalAmount' } } },
            ],
          },
        },
      ]),

      // Single settlement aggregation with $facet
      Settlement.aggregate([
        { $match: settlementBase },
        {
          $facet: {
            statusCounts: [
              {
                $group: {
                  _id: '$settlementStatus',
                  count: { $sum: 1 },
                  totalApproved: { $sum: '$approvedValue' },
                  totalSent: { $sum: '$sentValue' },
                },
              },
            ],
            todayCompleted: [
              { $match: { completedAt: { $gte: today, $lt: tomorrow } } },
              { $count: 'count' },
            ],
          },
        },
      ]),

      // Company wise distribution
      Replacement.aggregate([
        { $match: replacementBase },
        { $lookup: { from: 'companies', localField: 'company', foreignField: '_id', as: 'comp' } },
        { $unwind: '$comp' },
        { $group: { _id: '$company', name: { $first: '$comp.name' }, count: { $sum: 1 }, totalCases: { $sum: '$receivingCases' }, totalAmount: { $sum: '$approvalAmount' } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // Monthly trend (last 12 months)
      Replacement.aggregate([
        { $match: { ...replacementBase, receivingDate: { $gte: twelveMonthsAgo } } },
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
    ]);

    // Parse replacement facet results
    const rf = replacementFacet[0] || {};
    const getCount = (arr) => arr?.[0]?.count || 0;
    const getTotal = (arr) => arr?.[0]?.total || 0;

    // Parse settlement facet results
    const sf = settlementFacet[0] || {};
    const statusMap = {};
    (sf.statusCounts || []).forEach((s) => { statusMap[s._id] = s; });

    const settlementPending = (statusMap.PENDING?.count || 0) + (statusMap.PARTIAL?.count || 0) + (statusMap.ON_HOLD?.count || 0) + (statusMap.MATCHED?.count || 0);
    const totalApprovedValue = Object.values(statusMap).reduce((sum, s) => sum + (s.totalApproved || 0), 0);
    const totalSettledValue = statusMap.SETTLED?.totalSent || 0;
    const pendingSettlementValue = totalApprovedValue - totalSettledValue;

    const stats = {
      today: {
        received: getCount(rf.todayReceived),
        sent: getCount(rf.todaySent),
      },
      pending: {
        approval: getCount(rf.pendingApproval),
        dispatch: getCount(rf.pendingDispatch),
        invoice: getCount(rf.pendingInvoice),
      },
      totals: {
        casesReceived: getTotal(rf.totalCasesReceived),
        casesSent: getTotal(rf.totalCasesSent),
        approvalAmount: getTotal(rf.approvalAmount),
        pendingAmount: getTotal(rf.pendingAmount),
      },
      charts: { companyWise, monthlyStats, partyWise },
      topPending: { parties: topPendingParties, companies: topPendingCompanies },
      settlements: {
        pending: settlementPending,
        today: getCount(sf.todayCompleted),
        completed: statusMap.SETTLED?.count || 0,
        partial: statusMap.PARTIAL?.count || 0,
        onHold: statusMap.ON_HOLD?.count || 0,
        totalApprovedValue,
        totalSettledValue,
        pendingSettlementValue: Math.max(pendingSettlementValue, 0),
      },
    };

    ApiResponse.success(res, stats);
  } catch (error) {
    next(error);
  }
};

module.exports = { getDashboardStats };
