import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],

    // No real mailserver, no files on disk: SQLite runs in memory and the
    // key is throwaway.
    env: {
      ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      DATABASE_PATH: ':memory:'
    }
  }
});
