import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ADMIN_PASSWORD: 'test-password',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.js'],
  },
}))
