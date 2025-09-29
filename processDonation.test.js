// Basic smoke test for the Azure Function module
describe('Azure Function - processDonation', () => {
  test('should have processDonation directory with function.json', () => {
    const fs = require('fs');
    const path = require('path');
    const functionJsonPath = path.join(__dirname, 'processDonation', 'function.json');
    expect(fs.existsSync(functionJsonPath)).toBe(true);
  });

  test('should have processDonation directory with index.js', () => {
    const fs = require('fs');
    const path = require('path');
    const indexPath = path.join(__dirname, 'processDonation', 'index.js');
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  test('should contain required dependencies and setup', () => {
    const fs = require('fs');
    const path = require('path');
    const indexPath = path.join(__dirname, 'processDonation', 'index.js');
    const content = fs.readFileSync(indexPath, 'utf8');
    
    // Check that it contains required imports and setup
    expect(content).toContain('stripe');
    expect(content).toContain('@sendgrid/mail');
    expect(content).toContain('module.exports');
  });

  test('function.json should have correct bindings', () => {
    const fs = require('fs');
    const path = require('path');
    const functionJsonPath = path.join(__dirname, 'processDonation', 'function.json');
    const functionConfig = JSON.parse(fs.readFileSync(functionJsonPath, 'utf8'));
    
    expect(functionConfig.bindings).toBeDefined();
    expect(functionConfig.bindings).toHaveLength(2);
    expect(functionConfig.bindings[0].type).toBe('httpTrigger');
    expect(functionConfig.bindings[0].route).toBe('donation');
    expect(functionConfig.bindings[1].type).toBe('http');
  });
});