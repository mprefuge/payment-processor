module.exports = {
  // Allow tests to pass even if no tests are found
  passWithNoTests: true,
  // Skip the main test.js file from Jest 
  testPathIgnorePatterns: ['/node_modules/', 'test.js'],
  // Include the root level test files
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    '*.js',
    'processDonation/**/*.js',
    '!**/node_modules/**'
  ],
  // Configure test environment
  testEnvironment: 'node'
};