#!/bin/bash
#
# Deploys QBO Manual Sync integration to Salesforce using SFDX
#
# Usage:
#   ./deploy-salesforce-qbo-sync.sh <org-alias> <azure-function-url> <function-key>
#
# Example:
#   ./deploy-salesforce-qbo-sync.sh myorg https://your-app.azurewebsites.net your-key
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Arguments
ORG_ALIAS=$1
AZURE_FUNCTION_URL=$2
FUNCTION_KEY=$3

if [ -z "$ORG_ALIAS" ] || [ -z "$AZURE_FUNCTION_URL" ] || [ -z "$FUNCTION_KEY" ]; then
    echo -e "${RED}Usage: $0 <org-alias> <azure-function-url> <function-key>${NC}"
    echo ""
    echo "Example:"
    echo "  $0 myorg https://your-app.azurewebsites.net your-key"
    exit 1
fi

echo -e "${CYAN}=================================================="
echo "  QBO Manual Sync - Salesforce Deployment Script"
echo "==================================================${NC}"
echo ""

# Verify SFDX is installed
echo -e "${YELLOW}Checking SFDX installation...${NC}"
if ! command -v sfdx &> /dev/null; then
    echo -e "${RED}✗ SFDX is not installed. Please install Salesforce CLI.${NC}"
    exit 1
fi
SFDX_VERSION=$(sfdx --version)
echo -e "${GREEN}✓ SFDX is installed: $SFDX_VERSION${NC}"

# Verify org connection
echo -e "${YELLOW}Verifying org connection...${NC}"
if ! sfdx force:org:display --targetusername "$ORG_ALIAS" &> /dev/null; then
    echo -e "${RED}✗ Failed to connect to org '$ORG_ALIAS'. Please authenticate first.${NC}"
    echo -e "${YELLOW}  Run: sfdx force:auth:web:login --setalias $ORG_ALIAS${NC}"
    exit 1
fi
ORG_USERNAME=$(sfdx force:org:display --targetusername "$ORG_ALIAS" --json | jq -r '.result.username')
echo -e "${GREEN}✓ Connected to org: $ORG_USERNAME${NC}"

# Create project structure
echo -e "${YELLOW}Creating SFDX project structure...${NC}"
PROJECT_ROOT="qbo-sync-sfdx"

if [ -d "$PROJECT_ROOT" ]; then
    echo -e "${YELLOW}Removing existing project directory...${NC}"
    rm -rf "$PROJECT_ROOT"
fi

# Create SFDX project
sfdx force:project:create --projectname "qbo-sync" --outputdir "$PROJECT_ROOT"
cd "$PROJECT_ROOT"

# Create directory structure
mkdir -p force-app/main/default/objects/Transaction__c/fields
mkdir -p force-app/main/default/classes
mkdir -p force-app/main/default/triggers
mkdir -p force-app/main/default/layouts
mkdir -p force-app/main/default/permissionsets
mkdir -p force-app/main/default/objects/QBO_Sync_Settings__c/fields
mkdir -p force-app/main/default/namedCredentials
mkdir -p force-app/main/default/remoteSiteSettings

echo -e "${GREEN}✓ Project structure created${NC}"

# Create custom fields
echo -e "${YELLOW}Creating custom fields...${NC}"

# Function to create field metadata
create_field() {
    local field_name=$1
    local field_label=$2
    local field_type=$3
    local additional_xml=$4
    
    cat > "force-app/main/default/objects/Transaction__c/fields/${field_name}.field-meta.xml" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${field_name}</fullName>
    <label>${field_label}</label>
    <type>${field_type}</type>
${additional_xml}
</CustomField>
EOF
}

# QBO Target Account
create_field "QBO_Target_Account__c" "QBO Target Account" "Text" "    <length>255</length>
    <description>Name of the QuickBooks account to deposit to</description>"

# QBO Item Name
create_field "QBO_Item_Name__c" "QBO Item Name" "Text" "    <length>255</length>
    <defaultValue>\"General Giving\"</defaultValue>"

# QBO Class
create_field "QBO_Class__c" "QBO Class" "Text" "    <length>255</length>"

# QBO Department
create_field "QBO_Department__c" "QBO Department" "Text" "    <length>255</length>"

# Manual Sync Required
create_field "Manual_Sync_Required__c" "Manual Sync Required" "Checkbox" "    <defaultValue>false</defaultValue>"

# Sync Attempted Date
create_field "Sync_Attempted_Date__c" "Sync Attempted Date" "DateTime" ""

# Sync Attempt Count
create_field "Sync_Attempt_Count__c" "Sync Attempt Count" "Number" "    <precision>3</precision>
    <scale>0</scale>
    <defaultValue>0</defaultValue>"

echo -e "${GREEN}✓ Custom fields created${NC}"

# Create Custom Setting
echo -e "${YELLOW}Creating custom setting...${NC}"

cat > "force-app/main/default/objects/QBO_Sync_Settings__c/QBO_Sync_Settings__c.object-meta.xml" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>QBO Sync Settings</label>
    <pluralLabel>QBO Sync Settings</pluralLabel>
    <visibility>Protected</visibility>
    <customSettingsType>Hierarchy</customSettingsType>
    <enableFeeds>false</enableFeeds>
    <fields>
        <fullName>Auto_Sync_Enabled__c</fullName>
        <defaultValue>true</defaultValue>
        <label>Auto Sync Enabled</label>
        <type>Checkbox</type>
    </fields>
    <fields>
        <fullName>Auto_Contact_Matching_Enabled__c</fullName>
        <defaultValue>true</defaultValue>
        <label>Auto Contact Matching Enabled</label>
        <type>Checkbox</type>
    </fields>
    <fields>
        <fullName>Max_Sync_Attempts__c</fullName>
        <defaultValue>3</defaultValue>
        <label>Max Sync Attempts</label>
        <precision>2</precision>
        <scale>0</scale>
        <type>Number</type>
    </fields>
    <fields>
        <fullName>Sync_Batch_Size__c</fullName>
        <defaultValue>10</defaultValue>
        <label>Sync Batch Size</label>
        <precision>3</precision>
        <scale>0</scale>
        <type>Number</type>
    </fields>
</CustomObject>
EOF

echo -e "${GREEN}✓ Custom setting created${NC}"

# Create Named Credential
echo -e "${YELLOW}Creating Named Credential...${NC}"

cat > "force-app/main/default/namedCredentials/QBO_Manual_Sync_API.namedCredential-meta.xml" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>QBO Manual Sync API</label>
    <endpoint>${AZURE_FUNCTION_URL}</endpoint>
    <principalType>NamedUser</principalType>
    <protocol>NoAuthentication</protocol>
</NamedCredential>
EOF

echo -e "${GREEN}✓ Named Credential created${NC}"

# Create Remote Site Setting
echo -e "${YELLOW}Creating Remote Site Setting...${NC}"

cat > "force-app/main/default/remoteSiteSettings/QBO_Manual_Sync.remoteSite-meta.xml" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">
    <disableProtocolSecurity>false</disableProtocolSecurity>
    <isActive>true</isActive>
    <url>${AZURE_FUNCTION_URL}</url>
</RemoteSiteSetting>
EOF

echo -e "${GREEN}✓ Remote Site Setting created${NC}"

# Create Apex class stubs
echo -e "${YELLOW}Creating Apex class stubs...${NC}"

APEX_CLASSES=(
    "QBOManualSyncService"
    "QBOManualSyncController"
    "TransactionTriggerHandler"
    "QBOSyncQueueable"
    "QBOSyncScheduledBatch"
    "QBOManualSyncServiceTest"
)

for class_name in "${APEX_CLASSES[@]}"; do
    cat > "force-app/main/default/classes/${class_name}.cls" << 'EOF'
// This file needs to be populated with the actual Apex code from the documentation
// See: SALESFORCE_MANUAL_QBO_SYNC_SETUP.md - Section 6 (Apex Integration Code)
EOF
    
    cat > "force-app/main/default/classes/${class_name}.cls-meta.xml" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
    <status>Active</status>
</ApexClass>
EOF
done

echo -e "${YELLOW}⚠ Apex class stubs created - Manual copy required${NC}"

# Create trigger stub
cat > "force-app/main/default/triggers/TransactionTrigger.trigger" << 'EOF'
// This file needs to be populated with the actual trigger code from the documentation
// See: SALESFORCE_MANUAL_QBO_SYNC_SETUP.md - Section 6.3 (Apex Trigger)
EOF

cat > "force-app/main/default/triggers/TransactionTrigger.trigger-meta.xml" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
    <status>Active</status>
</ApexTrigger>
EOF

echo -e "${YELLOW}⚠ Trigger stub created - Manual copy required${NC}"

# Deploy to org
echo -e "${CYAN}=================================================="
echo "  Deploying to Salesforce Org"
echo "==================================================${NC}"

echo -e "${YELLOW}Deploying metadata...${NC}"
if sfdx force:source:deploy --sourcepath "force-app" --targetusername "$ORG_ALIAS"; then
    echo -e "${GREEN}✓ Deployment successful!${NC}"
else
    echo -e "${RED}✗ Deployment failed!${NC}"
    exit 1
fi

# Post-deployment configuration
echo -e "${CYAN}=================================================="
echo "  Post-Deployment Configuration"
echo "==================================================${NC}"

echo -e "${YELLOW}Creating default Custom Setting record...${NC}"
sfdx force:data:record:create --sobjecttype "QBO_Sync_Settings__c" \
    --values "Name='Default' Auto_Sync_Enabled__c=true Auto_Contact_Matching_Enabled__c=true Max_Sync_Attempts__c=3 Sync_Batch_Size__c=10" \
    --targetusername "$ORG_ALIAS" || echo -e "${YELLOW}⚠ Custom Setting record may already exist${NC}"

# Completion
echo -e "${CYAN}=================================================="
echo "  Deployment Complete!"
echo "==================================================${NC}"

echo -e "${GREEN}✓ Deployment Summary:${NC}"
echo "  - Custom fields deployed"
echo "  - Custom setting created"
echo "  - Apex class stubs created"
echo "  - Trigger stub created"
echo "  - Named Credential configured"
echo "  - Remote Site Setting added"

echo -e "${YELLOW}⚠ Manual Steps Required:${NC}"
echo "  1. Copy Apex code from documentation to class files"
echo "  2. Re-deploy after adding Apex code:"
echo "     sfdx force:source:deploy --sourcepath force-app --targetusername $ORG_ALIAS"
echo "  3. Configure Page Layouts (see documentation Step 2)"
echo "  4. Create Quick Actions (see documentation Step 3)"
echo "  5. Create List Views (see documentation Step 4)"
echo "  6. Create Reports (see documentation Step 5)"
echo "  7. Assign Permission Sets to users"
echo ""
echo "  Documentation: SALESFORCE_MANUAL_QBO_SYNC_SETUP.md"
echo ""

cd ..
echo -e "${GREEN}Project created at: $(pwd)/$PROJECT_ROOT${NC}"
echo ""
