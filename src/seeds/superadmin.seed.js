require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user.model');

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected for seeding...');

    // Check if super admin exists
    const existingAdmin = await User.findOne({ role: 'super_admin' });
    if (existingAdmin) {
      console.log(`Super Admin already exists: ${existingAdmin.username}`);
      process.exit(0);
    }

    // Create super admin
    const superAdmin = await User.create({
      username: 'superadmin',
      password: 'admin@123',
      role: 'super_admin',
      branch: 'Head Office',
      status: 'active',
    });

    console.log('=================================');
    console.log('Super Admin created successfully!');
    console.log(`Username: ${superAdmin.username}`);
    console.log('Password: admin@123');
    console.log('Role: super_admin');
    console.log('=================================');
    console.log('⚠️  CHANGE THIS PASSWORD IMMEDIATELY!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding error:', error.message);
    process.exit(1);
  }
};

seedSuperAdmin();
