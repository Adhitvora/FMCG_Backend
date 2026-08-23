const mongoose = require('mongoose');

const replacementSchema = new mongoose.Schema(
  {
    replacementId: {
      type: String,
      unique: true,
      required: true,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: [true, 'Company is required'],
    },
    party: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Party',
      required: [true, 'Party is required'],
    },
    town: {
      type: String,
      trim: true,
      default: '',
    },

    // ─── Receiving ───
    receivingDate: {
      type: Date,
      required: [true, 'Receiving date is required'],
    },
    receivingTransport: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transport',
      default: null,
    },
    receivingLRNo: {
      type: String,
      trim: true,
      default: '',
    },
    receivingCases: {
      type: Number,
      default: 0,
      min: 0,
    },
    receivingCartons: {
      type: Number,
      default: 0,
      min: 0,
    },
    receivingRemarks: {
      type: String,
      trim: true,
      default: '',
    },
    receiveImages: [{
      type: String,
    }],
    receiveDocuments: [{
      type: String,
    }],

    // ─── Dispatch ───
    sentDate: {
      type: Date,
      default: null,
    },
    dispatchTransport: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transport',
      default: null,
    },
    dispatchLRNo: {
      type: String,
      trim: true,
      default: '',
    },
    dispatchCases: {
      type: Number,
      default: 0,
      min: 0,
    },
    dispatchCartons: {
      type: Number,
      default: 0,
      min: 0,
    },
    dispatchRemarks: {
      type: String,
      trim: true,
      default: '',
    },
    dispatchImages: [{
      type: String,
    }],

    // ─── Approval ───
    approvalStatus: {
      type: String,
      enum: ['Pending', 'Approved', 'Rejected', 'Partial'],
      default: 'Pending',
    },
    approvalType: {
      type: String,
      enum: ['Amount', 'Product'],
      default: 'Amount',
    },
    approvalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    approvalProducts: [{
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
        default: null,
      },
      productName: { type: String, trim: true },
      mrp: { type: Number, min: 0, default: 0 },
      quantity: { type: Number, min: 0, default: 0 },
      totalValue: { type: Number, min: 0, default: 0 },
    }],
    totalProductApprovalValue: {
      type: Number,
      default: 0,
    },
    approvedCases: {
      type: Number,
      default: 0,
      min: 0,
    },
    rejectedCases: {
      type: Number,
      default: 0,
      min: 0,
    },
    approvalDate: {
      type: Date,
      default: null,
    },
    companyReference: {
      type: String,
      trim: true,
      default: '',
    },
    companyRLNo: {
      type: String,
      trim: true,
      default: '',
    },
    cnNo: {
      type: String,
      trim: true,
      default: '',
    },
    approvalDocuments: [{
      type: String,
    }],
    approvalRemark: {
      type: String,
      trim: true,
      default: '',
    },

    // ─── Invoice Link (auto-populated) ───
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
      default: null,
    },
    invoiceNumber: {
      type: String,
      default: '',
    },
    invoiceDate: {
      type: Date,
      default: null,
    },

    // ─── Carton Merge ───
    masterCartonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MasterCarton',
      default: null,
    },
    cartonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MasterCarton',
      default: null,
    },
    cartonStatus: {
      type: String,
      enum: ['AVAILABLE', 'MERGED', 'DISPATCHED'],
      default: 'AVAILABLE',
    },
    cartonGroupNumber: {
      type: Number,
      default: null,
    },
    cartonMergedAt: {
      type: Date,
      default: null,
    },
    cartonMergedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Lock dispatch once company approval is recorded.
    isDispatchLocked: {
      type: Boolean,
      default: false,
    },
    dispatchLockedAt: {
      type: Date,
      default: null,
    },
    dispatchLockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    dispatchUnlockedAt: {
      type: Date,
      default: null,
    },
    dispatchUnlockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    dispatchUnlockReason: {
      type: String,
      trim: true,
      default: '',
    },

    // ─── Meta ───
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'cancelled'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
replacementSchema.index({ company: 1, party: 1 });
replacementSchema.index({ receivingDate: -1 });
replacementSchema.index({ approvalStatus: 1 });
replacementSchema.index({ invoiceId: 1 });
replacementSchema.index({ masterCartonId: 1 });
replacementSchema.index({ cartonId: 1 });
replacementSchema.index({ company: 1, cartonStatus: 1, invoiceId: 1 });
replacementSchema.index({ party: 1, createdAt: -1 });
replacementSchema.index({ company: 1, createdAt: -1 });
replacementSchema.index({ sentDate: -1 });
replacementSchema.index({ isDispatchLocked: 1 });

replacementSchema.pre('validate', function (next) {
  if (this.cartonId && !this.masterCartonId) this.masterCartonId = this.cartonId;
  if (this.masterCartonId && !this.cartonId) this.cartonId = this.masterCartonId;

  if (this.cartonId && this.cartonStatus === 'AVAILABLE') this.cartonStatus = 'MERGED';
  if (!this.cartonId && this.cartonStatus !== 'DISPATCHED') {
    this.cartonStatus = 'AVAILABLE';
    this.cartonGroupNumber = null;
    this.cartonMergedAt = null;
    this.cartonMergedBy = null;
  }

  if (Array.isArray(this.approvalProducts)) {
    this.approvalProducts.forEach((product) => {
      const explicitValue = Number(product.totalValue || product.value || 0);
      const calculatedValue = Number(product.mrp || 0) * Number(product.quantity || 0);
      product.totalValue = explicitValue > 0 ? explicitValue : calculatedValue;
    });
    this.totalProductApprovalValue = this.approvalProducts.reduce((sum, product) => sum + (product.totalValue || 0), 0);
  }

  next();
});

// ─── Additional Performance Indexes ───
replacementSchema.index({ company: 1, status: 1 });
replacementSchema.index({ party: 1, status: 1 });
replacementSchema.index({ company: 1, approvalStatus: 1 });
replacementSchema.index({ status: 1, approvalStatus: 1 });
replacementSchema.index({ status: 1, sentDate: 1 });
replacementSchema.index({ status: 1, invoiceId: 1 });
replacementSchema.index({ status: 1, receivingDate: -1 });
replacementSchema.index({ cartonStatus: 1 });
replacementSchema.index({ company: 1, party: 1, receivingDate: -1 });

module.exports = mongoose.model('Replacement', replacementSchema);
