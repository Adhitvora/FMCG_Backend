const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema({
  replacement: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Replacement',
    required: true,
  },
  replacementId: {
    type: String,
    required: true,
  },
  party: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Party',
  },
  partyName: {
    type: String,
    default: '',
  },
  town: {
    type: String,
    default: '',
  },
  lrNo: {
    type: String,
    default: '',
  },
  actualCases: {
    type: Number,
    min: 0,
    default: 0,
  },
  cartonLabel: {
    type: String,
    default: '',
  },
  // Backward compat alias
  masterCartonNumber: {
    type: String,
    default: '',
  },
  cartonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MasterCarton',
    default: null,
  },
  cartonGroupNumber: {
    type: Number,
  },
  cartonDisplayValue: {
    type: Number,
  },
  receivingDate: Date,
  receivingCases: { type: Number, default: 0 },
  sentDate: Date,
  dispatchCases: { type: Number, default: 0 },
  approvalStatus: { type: String, default: 'Pending' },
  approvalAmount: { type: Number, default: 0 },
  approvedCases: { type: Number, default: 0 },
  rejectedCases: { type: Number, default: 0 },
  companyReference: { type: String, default: '' },
}, { _id: false });

const printHistorySchema = new mongoose.Schema({
  printedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: { type: String, default: '' },
  printedAt: { type: Date, default: Date.now },
}, { _id: false });

const cartonSchema = new mongoose.Schema({
  label: { type: String, required: true },
  masterCartonId: { type: mongoose.Schema.Types.ObjectId, ref: 'MasterCarton', default: null },
  totalCases: { type: Number, default: 0 },
}, { _id: false });

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      unique: true,
      required: true,
    },
    invoiceDate: {
      type: Date,
      required: true,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    companyName: {
      type: String,
      default: '',
    },
    companySnapshot: {
      name: { type: String, default: '' },
      address: { type: String, default: '' },
      gst: { type: String, default: '' },
      contact: { type: String, default: '' },
      email: { type: String, default: '' },
    },

    // ─── Dispatch Info ───
    transport: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transport',
      default: null,
    },
    transportName: {
      type: String,
      default: '',
    },
    lrNo: {
      type: String,
      trim: true,
      default: '',
    },
    dispatchDate: {
      type: Date,
      default: null,
    },
    packingMode: {
      type: String,
      enum: ['individual', 'merge'],
      default: 'merge',
    },

    // ─── Cartons (auto-created) ───
    cartons: [cartonSchema],

    // ─── Items ───
    items: [invoiceItemSchema],

    // ─── Totals ───
    totalCasesReceived: { type: Number, default: 0 },
    totalCasesSent: { type: Number, default: 0 },
    totalApprovedCases: { type: Number, default: 0 },
    totalRejectedCases: { type: Number, default: 0 },
    totalApprovalAmount: { type: Number, default: 0 },
  approvalType: { type: String, default: 'Amount' },
  approvalProducts: [{
    productName: { type: String, trim: true },
    mrp: { type: Number, min: 0, default: 0 },
    quantity: { type: Number, min: 0, default: 0 },
    totalValue: { type: Number, min: 0, default: 0 },
  }],
  totalProductApprovalValue: { type: Number, default: 0 },
    totalActualCases: { type: Number, default: 0 },

    // ─── PDF ───
    pdfPath: {
      type: String,
      default: '',
    },
    pdfGeneratedAt: {
      type: Date,
      default: null,
    },

    // ─── Lock ───
    isLocked: {
      type: Boolean,
      default: true,
    },
    lockedAt: {
      type: Date,
      default: null,
    },
    lockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ─── Print Tracking ───
    printHistory: [printHistorySchema],
    printCount: {
      type: Number,
      default: 0,
    },

    remarks: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['Active', 'Cancelled'],
      default: 'Active',
    },
    cancelledReason: {
      type: String,
      default: '',
    },
    cancelledDate: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

invoiceSchema.index({ invoiceDate: -1 });
invoiceSchema.index({ company: 1 });
invoiceSchema.index({ status: 1 });

// Calculate totals before save
invoiceSchema.pre('save', function (next) {
  this.totalCasesReceived = this.items.reduce((sum, i) => sum + (i.receivingCases || 0), 0);
  this.totalActualCases = this.items.reduce((sum, i) => {
    const cases = i.actualCases !== undefined && i.actualCases !== null
      ? i.actualCases
      : i.receivingCases;
    return sum + (cases || 0);
  }, 0);
  this.totalCasesSent = this.items.reduce((sum, i) => sum + (i.dispatchCases || 0), 0);
  this.totalApprovedCases = this.items.reduce((sum, i) => sum + (i.approvedCases || 0), 0);
  this.totalRejectedCases = this.items.reduce((sum, i) => sum + (i.rejectedCases || 0), 0);
  this.totalApprovalAmount = this.items.reduce((sum, i) => sum + (i.approvalAmount || 0), 0);
  next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);

