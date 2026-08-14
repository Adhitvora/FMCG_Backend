require('dotenv').config();
const mongoose = require('mongoose');

let _isReplicaSet = false;

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Auto-detect replica set support (needed for transactions)
    const adminDb = conn.connection.db.admin();
    try {
      const info = await adminDb.command({ replSetGetStatus: 1 });
      if (info.ok) {
        _isReplicaSet = true;
        console.log('✅ Replica set detected — transactions enabled');
      }
    } catch (err) {
      // Not a replica set (standalone) — transactions disabled
      _isReplicaSet = false;
      console.log('ℹ️  Standalone MongoDB — transactions disabled');
    }
  } catch (error) {
    console.error(`MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

const isReplicaSet = () => _isReplicaSet;

module.exports = { connectDB, isReplicaSet };
