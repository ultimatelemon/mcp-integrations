import { config } from '@ultimatelemon-eu/eslint-config/base';

export default config({
  rootDir: import.meta.dirname,
  ignores: ['dist/'],
  extra: [
    // The CLI talks to the operator on stdout, and log.ts is the logger.
    { files: ['src/cli/**', 'src/log.ts'], rules: { 'no-console': 'off' } },
    // Async stubs stand in for async tools, throwing included.
    {
      files: ['tests/**'],
      rules: { '@typescript-eslint/require-await': 'off' }
    }
  ]
});
