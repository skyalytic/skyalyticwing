/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/unit'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // 源码使用 ESM 风格 `.js` 后缀导入 TS 文件，重写为无后缀以匹配 .ts
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          moduleResolution: 'node',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          skipLibCheck: true,
          strict: false,
          noUnusedLocals: false,
          noUnusedParameters: false,
          types: ['jest', 'node'],
        },
      },
    ],
  },
  // 覆盖率统计范围与阈值（jest --coverage 时生效；普通 jest 不做阈值检查）
  collectCoverageFrom: ['src/**/*.ts'],
  coverageThreshold: {
    global: {
      statements: 17,
      branches: 9,
      functions: 15,
      lines: 17,
    },
  },
};
