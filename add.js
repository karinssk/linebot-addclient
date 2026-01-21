// add-admin.js

const mysql = require('mysql2');
const bcrypt = require('bcryptjs');

// ==== Config ====
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'root258369',
  database: 'rubyshop.co.th_shop'
});

// ==== Input Admin Info ====
const admin = {
  first_name: 'Admin',
  last_name: 'User',
  username: 'admin001',
  email: 'admin001@example.com',
  password: 'admin1234', // Will be hashed
  user_type: 'admin',    // Make sure this is allowed in your system
  language: 'en',
  allow_login: 1,
  status: 'active',
  created_at: new Date(),
  updated_at: new Date()
};

// ==== Hash Password ====
bcrypt.hash(admin.password, 10, (err, hash) => {
  if (err) {
    console.error('Error hashing password:', err);
    return;
  }

  admin.password = hash;

  const query = `
    INSERT INTO users (
      user_type, first_name, last_name, username, email, password, language,
      allow_login, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const values = [
    admin.user_type,
    admin.first_name,
    admin.last_name,
    admin.username,
    admin.email,
    admin.password,
    admin.language,
    admin.allow_login,
    admin.status,
    admin.created_at,
    admin.updated_at
  ];

  connection.query(query, values, (error, results) => {
    if (error) {
      console.error('Error inserting admin user:', error);
    } else {
      console.log('Admin user added successfully with ID:', results.insertId);
    }

    connection.end();
  });
});
