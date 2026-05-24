'use strict';

const { Sequelize } = require('sequelize');
const config = require('../config');
const logger = require('../logger');

const sequelize = new Sequelize(config.db.database, config.db.user, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'mysql',
  logging: (msg) => logger.trace({ sql: msg }, 'sql'),
  pool: { max: 10, min: 0, idle: 10000, acquire: 30000 },
  define: { underscored: true, freezeTableName: true },
});

module.exports = { sequelize };
