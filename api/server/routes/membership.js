const { createMCPMembershipRouter } = require('@librechat/api');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config');
const { getMCPGroupMembership } = require('~/models');

module.exports = createMCPMembershipRouter({
  getAppConfig,
  getMCPGroupMembership,
  runWithContext: tenantStorage.run.bind(tenantStorage),
  env: process.env,
  logger,
});
