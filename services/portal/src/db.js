'use strict';

const { Pool } = require('pg');

// Single shared pool for the whole portal service. Connection settings are
// read from the standard PG* environment variables (PGHOST, PGPORT,
// PGDATABASE, PGUSER, PGPASSWORD), consistent across all routes.
const pool = new Pool();

module.exports = pool;
