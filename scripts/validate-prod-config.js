#!/usr/bin/env node
/** Fail-closed production configuration validation. */
const { validate } = require('../backend/services/production-config');
const issues = validate(process.env);
if (issues.length) {
  console.error('Production config validation FAILED:');
  issues.forEach((i) => console.error(' - ' + i));
  process.exit(1);
}
console.log(process.env.NODE_ENV === 'production'
  ? 'Production config validation PASS'
  : 'Production config validation skipped (NODE_ENV is not production)');
