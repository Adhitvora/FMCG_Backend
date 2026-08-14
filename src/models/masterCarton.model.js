const mongoose = require('mongoose');

const masterCartonSchema = new mongoose.Schema(
  {
    cartonNumber: {
      type: String,
      unique: true,
      required: true,
    },
    entries: [
      {
        party: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Party',
          required: true,
        },
        partyName: {
          type: String,
          required: true,
        },
        cases: {
          type: Number,
          required: true,
          min: 1,
        },
        replacementId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Replacement',
          required: true,
        },
      },
    ],
    totalCases: {
      type: Number,
      default: 0,
      min: 0,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    status: {
      type: String,
      enum: ['Open', 'Sealed', 'Dispatched'],
      default: 'Open',
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

masterCartonSchema.index({ company: 1 });
masterCartonSchema.index({ status: 1 });

// Auto-calculate totalCases before save
masterCartonSchema.pre('save', function (next) {
  this.totalCases = this.entries.reduce((sum, e) => sum + e.cases, 0);
  next();
});

module.exports = mongoose.model('MasterCarton', masterCartonSchema);
