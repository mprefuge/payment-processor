// Basic smoke test for the Azure Function module
describe('Azure Function - processDonation', () => {
  test('should have processDonation.js file', () => {
    const fs = require('fs');
    const path = require('path');
    const functionPath = path.join(__dirname, 'processDonation.js');
    expect(fs.existsSync(functionPath)).toBe(true);
  });

  test('should contain required Azure Functions setup', () => {
    const fs = require('fs');
    const path = require('path');
    const functionPath = path.join(__dirname, 'processDonation.js');
    const content = fs.readFileSync(functionPath, 'utf8');
    
    // Check that it contains Azure Functions imports and setup
    expect(content).toContain('@azure/functions');
    expect(content).toContain('app.http');
    expect(content).toContain('stripe');
  });
});