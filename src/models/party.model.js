const mongoose = require('mongoose');

const partySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Party name is required'],
      trim: true,
    },
    town: {
      type: String,
      trim: true,
      default: '',
    },
    gst: {
      type: String,
      trim: true,
      default: '',
    },
    mobile: {
      type: String,
      trim: true,
      default: '',
    },
    address: {
      type: String,
      trim: true,
      default: '',
    },
    route: {
      type: String,
      trim: true,
      default: '',
    },
    transport: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transport',
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index for duplicate detection
partySchema.index({ name: 1, town: 1, gst: 1 }, { unique: true });
partySchema.index({ name: 1 });
partySchema.index({ town: 1 });
partySchema.index({ status: 1 });
partySchema.index({ name: 1, status: 1 });
partySchema.index({ company: 1, status: 1 });
partySchema.index({ name: 'text', town: 'text' });

module.exports = mongoose.model('Party', partySchema);
