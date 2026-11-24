const { createMCPMembershipRouter, resolveDownloadPath } = require('@librechat/api');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config');
const db = require('~/models');
const { savePreparedImage } = require('~/server/services/Files/process');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeImageBuffer } = require('~/server/services/Files/images/resize');

module.exports = createMCPMembershipRouter({
  getAppConfig,
  getMCPGroupMembership: db.getMCPGroupMembership,
  getMCPGroupCatalog: db.getMCPGroupCatalog,
  imageImport: {
    findPrincipalUser: db.findPrincipalUser,
    getMessage: db.getMessage,
    getStorageConfig: ({ id: userId, ...principal }) => getAppConfig({ userId, ...principal }),
    findFileById: db.findFileById,
    attachMCPImage: db.attachMCPImage,
    savePreparedImage,
    readStoredImage: (req, file) =>
      getStrategyFunctions(file.source).getDownloadStream(req, resolveDownloadPath(file)),
    resizeImageBuffer,
    logger,
  },
  runWithContext: tenantStorage.run.bind(tenantStorage),
  env: process.env,
  logger,
});
