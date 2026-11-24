const { createMCPMembershipRouter } = require('@librechat/api');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config');
const { getMCPGroupMembership, getMCPGroupCatalog } = require('~/models');

module.exports = createMCPMembershipRouter({
  getAppConfig,
  getMCPGroupMembership,
  getMCPGroupCatalog,
  runWithContext: tenantStorage.run.bind(tenantStorage),
  env: process.env,
  logger,
});
