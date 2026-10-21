import { config } from '@ultimatelemon-eu/eslint-config/base';

export default config({
  rootDir: import.meta.dirname,
  ignores: ['dist/', 'fixtures/', 'specs/']
});
