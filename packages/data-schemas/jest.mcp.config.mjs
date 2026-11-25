import base from './jest.config.mjs';
export default {
  ...base,
  transform: {
    '\\.[cm]?[jt]sx?$': [
      'babel-jest',
      {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-typescript',
        ],
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!(@modelcontextprotocol/sdk|uuid)/)'],
  moduleNameMapper: {
    '^librechat-data-provider$': '<rootDir>/../data-provider/src/index.ts',
    '^~/files/generation$': '<rootDir>/../api/src/files/generation.ts',
    '^~/utils/errors$': '<rootDir>/../api/src/utils/errors.ts',
    '^~/admin/lease$': '<rootDir>/../api/src/admin/lease.ts',
    '^~/acl/codes$': '<rootDir>/../api/src/acl/codes.ts',
    ...base.moduleNameMapper,
  },
};
