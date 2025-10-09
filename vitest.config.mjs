import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['__tests__/**/*.test.{js,ts}'],
        environment: 'node',
        restoreMocks: true
    }
});
