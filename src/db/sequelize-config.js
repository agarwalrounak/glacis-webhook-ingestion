'use strict';

// Used by sequelize-cli (migrations). The runtime app uses src/db/index.js
// directly with the same shared config.
require('dotenv').config();

const common = {
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'glacis',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  dialect: 'mysql',
  logging: false,
};

module.exports = {
  development: common,
  test: { ...common, database: `${common.database}_test` },
  production: common,
};
