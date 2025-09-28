module.exports = {
  // Allow tests to pass even if no tests are found
  passWithNoTests: true,
  // Skip the main test.js file from Jest 
  testPathIgnorePatterns: ['/node_modules/', 'test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!**/node_modules/**'
  ],
  // Configure test environment
  testEnvironment: 'node'
};