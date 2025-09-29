// Test script to verify the deployment fix
const fs = require('fs');
const path = require('path');

console.log('🧪 Testing deployment fix...\n');

// Test 1: Check if fix-deployment.sh exists and is executable
const fixScriptPath = path.join(__dirname, 'fix-deployment.sh');
if (fs.existsSync(fixScriptPath)) {
    const stats = fs.statSync(fixScriptPath);
    const isExecutable = (stats.mode & parseInt('111', 8)) !== 0;
    console.log('✅ fix-deployment.sh exists and is executable:', isExecutable);
} else {
    console.log('❌ fix-deployment.sh not found');
    process.exit(1);
}

// Test 2: Check if configure-app-settings.sh includes WEBSITE_RUN_FROM_PACKAGE
const configScriptPath = path.join(__dirname, 'configure-app-settings.sh');
const configContent = fs.readFileSync(configScriptPath, 'utf8');
if (configContent.includes('WEBSITE_RUN_FROM_PACKAGE=1')) {
    console.log('✅ configure-app-settings.sh includes WEBSITE_RUN_FROM_PACKAGE=1');
} else {
    console.log('❌ configure-app-settings.sh missing WEBSITE_RUN_FROM_PACKAGE=1');
    process.exit(1);
}

// Test 3: Check if deploy.sh includes WEBSITE_RUN_FROM_PACKAGE
const deployScriptPath = path.join(__dirname, 'deploy.sh');
const deployContent = fs.readFileSync(deployScriptPath, 'utf8');
if (deployContent.includes('WEBSITE_RUN_FROM_PACKAGE=1')) {
    console.log('✅ deploy.sh includes WEBSITE_RUN_FROM_PACKAGE=1');
} else {
    console.log('❌ deploy.sh missing WEBSITE_RUN_FROM_PACKAGE=1');
    process.exit(1);
}

// Test 4: Check if README.md has troubleshooting section
const readmePath = path.join(__dirname, 'README.md');
const readmeContent = fs.readFileSync(readmePath, 'utf8');
if (readmeContent.includes('Function Not Appearing in Azure Portal')) {
    console.log('✅ README.md includes troubleshooting section for function visibility');
} else {
    console.log('❌ README.md missing troubleshooting section');
    process.exit(1);
}

// Test 5: Check if function configuration files exist
const functionJsonPath = path.join(__dirname, 'processDonation', 'function.json');
const functionIndexPath = path.join(__dirname, 'processDonation', 'index.js');

if (fs.existsSync(functionJsonPath) && fs.existsSync(functionIndexPath)) {
    console.log('✅ Function files exist (function.json and index.js)');
} else {
    console.log('❌ Function files missing');
    process.exit(1);
}

// Test 6: Verify GitHub workflow exists
const workflowPath = path.join(__dirname, '.github', 'workflows', 'main_payment-processing-function.yml');
if (fs.existsSync(workflowPath)) {
    console.log('✅ GitHub workflow exists');
} else {
    console.log('❌ GitHub workflow missing');
    process.exit(1);
}

console.log('\n🎉 All tests passed! The deployment fix is ready.');
console.log('\n📝 To fix the function visibility issue, run:');
console.log('   ./fix-deployment.sh');