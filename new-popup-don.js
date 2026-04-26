const processDonationAPI = 'http://localhost:7071/api/transaction';//'https://db6a711f4383e668bf1e88325abdab.17.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/aa6dd00627e9488eb2d9e5af99110e26/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=o9u5MqSJayNl2ryEnLumZ1qUbpD2EX9SKBt4K8TvLIw'; //'https://prod-08.westus.logic.azure.com:443/workflows/aa6dd00627e9488eb2d9e5af99110e26/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=lnc3194xuZhPQnVi6pDF_LuvDSG8BElOsVFllpS6UpE';

(function () {
  "use strict";

  var BRAND_PRIMARY = "#BD2135";
  var BRAND_SECONDARY = "#000000";
  var BRAND_TERTIARY = "#ffffff";

  var states = ["", "AL - Alabama", "AK - Alaska", "AZ - Arizona", "AR - Arkansas", "CA - California", "CO - Colorado", "CT - Connecticut", "DE - Delaware", "FL - Florida", "GA - Georgia", "HI - Hawaii", "ID - Idaho", "IL - Illinois", "IN - Indiana", "IA - Iowa", "KS - Kansas", "KY - Kentucky", "LA - Louisiana", "ME - Maine", "MD - Maryland", "MA - Massachusetts", "MI - Michigan", "MN - Minnesota", "MS - Mississippi", "MO - Missouri", "MT - Montana", "NE - Nebraska", "NV - Nevada", "NH - New Hampshire", "NJ - New Jersey", "NM - New Mexico", "NY - New York", "NC - North Carolina", "ND - North Dakota", "OH - Ohio", "OK - Oklahoma", "OR - Oregon", "PA - Pennsylvania", "RI - Rhode Island", "SC - South Carolina", "SD - South Dakota", "TN - Tennessee", "TX - Texas", "UT - Utah", "VT - Vermont", "VA - Virginia", "WA - Washington", "WV - West Virginia", "WI - Wisconsin", "WY - Wyoming", "Outside US"];
  var countries = ["", "United States", "Afghanistan", "Akrotiri", "Albania", "Algeria", "American Samoa", "Andorra", "Angola", "Anguilla", "Antarctica", "Antigua and Barbuda", "Argentina", "Armenia", "Aruba", "Ashmore and Cartier Islands", "Australia", "Austria", "Azerbaijan", "Bahamas, The", "Bahrain", "Bangladesh", "Barbados", "Bassas da India", "Belarus", "Belgium", "Belize", "Benin", "Bermuda", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Bouvet Island", "Brazil", "British Indian Ocean Territory", "British Virgin Islands", "Brunei", "Bulgaria", "Burkina Faso", "Burma", "Burundi", "Cambodia", "Cameroon", "Canada", "Cape Verde", "Cayman Islands", "Central African Republic", "Chad", "Chile", "China", "Christmas Island", "Clipperton Island", "Cocos (Keeling) Islands", "Colombia", "Comoros", "Congo, Democratic Republic of the", "Congo, Republic of the", "Cook Islands", "Coral Sea Islands", "Costa Rica", "Cote d'Ivoire", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark", "Dhekelia", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Ethiopia", "Europa Island", "Falkland Islands (Islas Malvinas)", "Faroe Islands", "Fiji", "Finland", "France", "French Guiana", "French Polynesia", "French Southern and Antarctic Lands", "Gabon", "Gambia, The", "Gaza Strip", "Georgia", "Germany", "Ghana", "Gibraltar", "Glorioso Islands", "Greece", "Greenland", "Grenada", "Guadeloupe", "Guam", "Guatemala", "Guernsey", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Heard Island and McDonald Islands", "Holy See (Vatican City)", "Honduras", "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Isle of Man", "Israel", "Italy", "Jamaica", "Jan Mayen", "Japan", "Jersey", "Jordan", "Juan de Nova Island", "Kazakhstan", "Kenya", "Kiribati", "North Korea", "South Korea", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Macau", "Macedonia", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Martinique", "Mauritania", "Mauritius", "Mayotte", "Mexico", "Micronesia, Federated States of", "Moldova", "Monaco", "Mongolia", "Montserrat", "Morocco", "Mozambique", "Namibia", "Nauru", "Navassa Island", "Nepal", "Netherlands", "Netherlands Antilles", "New Caledonia", "New Zealand", "Nicaragua", "Niger", "Nigeria", "Niue", "Norfolk Island", "Northern Ireland", "Northern Mariana Islands", "Norway", "Oman", "Pakistan", "Palau", "Panama", "Papua New Guinea", "Paracel Islands", "Paraguay", "Peru", "Philippines", "Pitcairn Islands", "Poland", "Portugal", "Puerto Rico", "Qatar", "Reunion", "Romania", "Russia", "Rwanda", "Saint Helena", "Saint Kitts and Nevis", "Saint Lucia", "Saint Pierre and Miquelon", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia and Montenegro", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Georgia and the South Sandwich Islands", "Spain", "Spratly Islands", "Sri Lanka", "Sudan", "Suriname", "Svalbard", "Swaziland", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tokelau", "Tonga", "Trinidad and Tobago", "Tromelin Island", "Tunisia", "Turkey", "Turkmenistan", "Turks and Caicos Islands", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "Uruguay", "Uzbekistan", "Vanuatu", "Venezuela", "Vietnam", "Virgin Islands", "Wake Island", "Wallis and Futuna", "West Bank", "Western Sahara", "Yemen", "Zambia", "Zimbabwe", "Myanmar (Burma)", "Palestine", "Democratic Republic of the Congo", "Not Listed"];

  var style = `
  <style id="donation-popup-style">
    :root { --brand:#BD2135; }
    .dp-modal { display:none; position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,.48); align-items:center; justify-content:center; }
    .dp-panel { background:#fff; width:100%; max-width:760px; border-radius:24px; box-shadow:0 10px 40px rgba(0,0,0,.15); overflow:visible; }
    .dp-header { display:flex; align-items:center; justify-content:center; position:relative; padding:12px 16px; background:#fff; color:#000; border-bottom:4px solid var(--brand); border-radius:24px 24px 0 0; }
    .dp-header .dp-btn-back { position:absolute; left:16px; margin:0; }
    .dp-header img { height:56px; }
    .dp-close { position:absolute; top:50%; right:16px; transform:translateY(-50%); font-size:24px; line-height:1; color:#000; opacity:.75; cursor:pointer; border:0; background:transparent; }
    .dp-close:hover { opacity:1; }
    .dp-body { padding:16px; max-width:700px; margin:0 auto; position:relative; overflow:visible; }
    .dp-card { background:#fff; border-radius:18px; box-shadow: 0 6px 24px rgba(189,33,53,0.10), 0 1px 6px rgba(0,0,0,0.08); padding:24px; margin-bottom:16px; max-width:700px; margin-left:auto; margin-right:auto; overflow:visible; }
    .dp-title { font-weight:700; margin-bottom:16px; text-align:center; }
    .dp-grid { display:grid; gap:12px; }
    .dp-grid-2 { grid-template-columns: 1fr 1fr; }
    .dp-grid-3 { grid-template-columns: 2fr 1fr; }
    .dp-grid-4 { grid-template-columns: 1fr 1fr 1fr 1fr; }
    .dp-label { display:block; font-size:14px; font-weight:600; margin-bottom:6px; color:#222; }
    .dp-input, .dp-select { width:100%; padding:12px; border:1.5px solid #e0e0e0; border-radius:10px; background:#fafbfc; font-size:16px; outline:none; transition:.2s border-color,.2s box-shadow,.2s background; box-sizing:border-box; }
    .dp-input:focus, .dp-select:focus { border-color:var(--brand); box-shadow:0 0 0 2px #BD213533; background:#fff; }
    .dp-row { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; }
    .dp-amount-row { flex-wrap:nowrap; margin-bottom:8px; }
    .dp-amount-row:last-child { margin-bottom:0; }
    .dp-chip { padding:12px 18px; border-radius:999px; border:1.5px solid #d4d4d4; background:#fff; font-weight:700; cursor:pointer; transition:.2s; font-size:16px; }
    .dp-chip:hover { border-color:var(--brand); color:var(--brand); }
    .dp-chip.selected { background:var(--brand); border-color:var(--brand); color:#fff; box-shadow:0 2px 10px rgba(189,33,53,.25); }
    
    /* Amount chips with more rectangular styling */
    .dp-amount-chip { border-radius:8px; min-width:90px; padding:14px 18px; font-size:18px; font-weight:800; white-space:nowrap; }
    .dp-amount-chip:hover { transform:translateY(-1px); box-shadow:0 4px 12px rgba(189,33,53,.15); }
    .dp-amount-chip.selected { transform:translateY(-1px); box-shadow:0 4px 12px rgba(189,33,53,.25); }
    
    /* Frequency chips */
    .dp-frequency-chip { border-radius:8px; min-width:120px; }
    
    /* Tribute chips */
    .dp-tribute-chip { border-radius:8px; min-width:120px; }
    
    /* Donation type chips */
    .dp-donation-type-chip { border-radius:8px; min-width:120px; }
    
    /* Frequency options */
    .dp-frequency-container { display:flex; flex-direction:column; gap:8px; }
    .dp-frequency-options { justify-content:center; }
    
    /* Elegant frequency stepper */
    .dp-recurring-stepper { margin-top:12px; }
    .dp-stepper-container { display:flex; align-items:center; justify-content:center; gap:12px; }
    .dp-stepper-btn { 
      display:flex; align-items:center; justify-content:center; 
      width:32px; height:32px; border-radius:50%; 
      border:2px solid var(--brand); background:transparent; color:var(--brand); 
      cursor:pointer; font-size:20px; font-weight:700; transition:.2s; 
    }
    .dp-stepper-btn:hover { background:var(--brand); color:#fff; }
    .dp-stepper-btn:disabled { 
      opacity:0.3; cursor:not-allowed; border-color:#ccc; color:#ccc; 
    }
    .dp-stepper-btn:disabled:hover { background:transparent; color:#ccc; }
    .dp-stepper-display { 
      font-size:16px; font-weight:600; color:#333; 
      min-width:100px; text-align:center; 
      padding:8px 16px; border-radius:8px; 
      background:#f8f9fa; border:1px solid #e9ecef; 
    }
    
    /* Personal info card wider */
    .dp-personal-info-card { max-width:700px; margin:0 auto; }
    
    /* Back arrow positioning */
    .dp-back-arrow-container { margin-bottom:16px; }
    .dp-back-arrow-container .dp-btn-back { margin:0; }
    
    /* Fee checkbox positioning fix */
    .dp-fee-checkbox-container { 
      position:relative; 
      z-index:1; 
      display:flex; 
      justify-content:center; 
      align-items:center; 
    }
    
    /* Payment method grid layout for more elegant appearance */
    .dp-payment-grid { 
      display:grid; 
      grid-template-columns:repeat(3,1fr); 
      gap:12px; 
      justify-items:center; 
      margin-bottom:16px; 
    }
    
    .dp-payment-chip { 
      display:flex; 
      flex-direction:column; 
      align-items:center; 
      gap:6px; 
      padding:16px 20px; 
      min-width:140px; 
      max-width:160px; 
      min-height:120px;
      text-align:center; 
      border-radius:16px !important; 
      transition:.3s all ease; 
      justify-content:center;
    }
    .dp-payment-chip:hover { transform:translateY(-3px); box-shadow:0 8px 20px rgba(189,33,53,.2); }
    .dp-payment-chip img, .dp-payment-chip svg { margin-bottom:6px; }
    .dp-payment-chip span { font-weight:600; font-size:14px; }
    .dp-payment-chip small { font-size:11px; font-weight:500; opacity:0.8; margin-top:2px; }
    .dp-payment-chip.selected { transform:translateY(-3px); box-shadow:0 8px 20px rgba(189,33,53,.4); }
    
    /* Icon color inversion when payment method is selected */
    .dp-payment-chip.selected img { filter: invert(1); }
    .dp-payment-chip.selected svg .wallet-svg-main { fill: #fff; stroke: #fff; }
    .dp-payment-chip.selected svg .wallet-svg-circle { fill: var(--brand); }
    .dp-payment-chip.selected svg .wallet-svg-bar { fill: var(--brand); }
    
    /* Card type chips for sub-selection */
    .dp-card-type-chip {
      display:flex;
      flex-direction:column;
      align-items:center;
      gap:4px;
      padding:12px 16px;
      min-width:100px;
      text-align:center;
      border-radius:12px !important;
      transition:.3s all ease;
    }
    .dp-card-type-chip:hover { transform:translateY(-2px); box-shadow:0 4px 12px rgba(189,33,53,.15); }
    .dp-card-type-chip span { font-weight:600; font-size:13px; }
    .dp-card-type-chip small { font-size:10px; font-weight:500; opacity:0.8; }
    .dp-card-type-chip.selected { transform:translateY(-2px); box-shadow:0 4px 12px rgba(189,33,53,.3); }
    /* Keep original logo colors when selected - only change wallet explainer text to white */
    .dp-payment-chip.selected .dp-wallet-explainer { color:#fff; }
    
    .dp-payment-methods { justify-content:center; }
    .dp-fee { font-size:13px; color:#444; margin-top:6px; }
    .dp-summary { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .dp-summary .dp-total { font-weight:800; font-size:24px; color:var(--brand); }
    .dp-cta { display:block; width:100%; padding:16px; font-size:20px; font-weight:800; border:0; border-radius:12px; background:var(--brand); color:#fff; cursor:pointer; transition:.2s; box-shadow:0 6px 20px rgba(189,33,53,.18); }
    .dp-cta:hover { background:#a81c2d; }
    .dp-trust { text-align:center; font-size:12px; color:#555; margin-top:6px; }
    .dp-trust-logos { display:flex; align-items:center; justify-content:center; gap:12px; margin-top:8px; }
    .dp-ecfa-logo { height:96px; opacity:0.8; transition:opacity 0.2s ease; }
    .dp-ecfa-logo:hover { opacity:1; }

    /* Embedded */
    .dp-embedded { max-width:760px; margin:0 auto; }
    .dp-embedded .dp-panel { max-width:none; border-radius:20px; }
    .dp-embedded .dp-header { border-radius:20px 20px 0 0; }

    .dp-steps { display:flex; justify-content:center; margin-bottom:20px; }
    .dp-step { display:flex; align-items:center; justify-content:center; width:12px; height:12px; border-radius:50%; background:#ccc; color:#666; font-weight:700; margin:0 8px; position:relative; }
    .dp-step.active { background:var(--brand); color:#fff; }
    .dp-step.completed { background:#000; color:#fff; }
    .dp-step::after { content:''; position:absolute; top:50%; left:100%; width:40px; height:2px; background:#ccc; transform:translateY(-50%); z-index:-1; }
    .dp-step:last-child::after { display:none; }
    .dp-step.completed::after { background:#000; }
    .dp-step.active::after { background:var(--brand); }
    
    .dp-step-content { display:none; }
    .dp-step-content.active { display:block; }
    .dp-nav-buttons { display:flex; justify-content:space-between; margin-top:20px; }
    .dp-btn { padding:12px 24px; border:2px solid var(--brand); background:var(--brand); color:#fff; border-radius:8px; cursor:pointer; font-weight:600; transition:.3s all ease; }
    .dp-btn.secondary { background:transparent; color:var(--brand); }
    .dp-btn:hover { opacity:0.9; transform:translateY(-1px); box-shadow:0 4px 12px rgba(189,33,53,.25); }
    .dp-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .dp-btn-back { display:flex; align-items:center; justify-content:center; width:48px; height:48px; border:2px solid var(--brand); background:transparent; color:var(--brand); border-radius:50%; cursor:pointer; font-size:24px; font-weight:700; transition:.2s; margin-right:12px; flex-shrink:0; }
    /* Custom checkbox styling to match theme */
    .dp-checkbox-container { position:relative; display:inline-flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:12px; }
    .dp-checkbox { appearance:none; width:20px; height:20px; border:2px solid #e0e0e0; border-radius:4px; background:#fff; cursor:pointer; transition:.2s; position:relative; }
    .dp-checkbox:checked { background:var(--brand); border-color:var(--brand); }
    .dp-checkbox:checked::after { content:'✓'; position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); color:#fff; font-size:12px; font-weight:700; }
    .dp-checkbox:focus { outline:none; box-shadow:0 0 0 2px rgba(189,33,53,.25); }
    
    /* Total display styling */
    .dp-total-container { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
    .dp-total-amount { font-size:18px; font-weight:700; color:#000000; flex:1; text-align:center; margin-right:16px; }
    
    /* Wallet explainer text */
    .dp-wallet-explainer { font-size:10px; color:#666; margin-top:2px; text-align:center; line-height:1.2; word-wrap:break-word; overflow-wrap:break-word; max-width:100%; }
    .dp-btn-back:hover { background:var(--brand); color:#fff; }
    
    /* Error message styling */
    .dp-error-message { color:var(--brand); font-size:12px; font-weight:600; margin-top:4px; display:none; }
    
    /* Step 3 specific positioning */
    .dp-step3-container { position:relative; }
    
    /* Responsive */
    @media (max-width: 600px) {
      .dp-modal { padding: 10px; }
      .dp-panel { width: 100%; max-width: none; max-height:90vh; border-radius:12px; overflow-y:auto; overflow-x:visible; }
      .dp-header { border-radius:12px 12px 0 0; }
      .dp-body { padding:12px; position:relative; overflow:visible; }
      .dp-grid-2, .dp-grid-3, .dp-grid-4 { grid-template-columns: 1fr; }
      .dp-cta { border-radius:999px; font-size:18px; }
      .dp-summary .dp-total { font-size:22px; }
      .dp-row { justify-content: center; }
      .dp-amount-row { flex-wrap:wrap; justify-content:center; margin-bottom:8px; }
      .dp-amount-row:last-child { margin-bottom:0; }
      .dp-chip { padding:10px 14px; font-size:15px; }
      .dp-payment-grid { grid-template-columns:1fr; gap:8px; }
      .dp-payment-chip { min-width:100%; max-width:100%; min-height:100px; padding:12px 16px; }
      .dp-card-type-chip { min-width:80px; padding:8px 12px; }
      
      /* Ensure address dropdown is not clipped */
      .dp-card { overflow:visible; }
      #popup-address-suggestions, #embedded-address-suggestions { 
        z-index:10000 !important; 
        max-height:200px !important;
      }
    }
    @media (min-width: 601px) and (max-width: 900px) {
      .dp-amount-row { flex-wrap:wrap; justify-content:center; margin-bottom:8px; }
      .dp-amount-row:last-child { margin-bottom:0; }
      .dp-amount-chip { min-width:85px; padding:12px 16px; font-size:16px; }
    }
    @media (max-width: 400px) {
      .dp-modal { padding: 8px; }
      .dp-panel { width: 100%; max-width: none; max-height:85vh; overflow-y:auto; overflow-x:visible; border-radius:8px; }
      .dp-header { border-radius:8px 8px 0 0; }
      .dp-body { padding:8px; }
      .dp-card { padding:18px; margin-bottom:12px; }
      .dp-grid { gap:8px; }
      .dp-row { gap:6px; }
      .dp-amount-row { flex-wrap:wrap; margin-bottom:8px; }
      .dp-amount-row:last-child { margin-bottom:0; }
      .dp-chip { padding:8px 12px; font-size:14px; }
      .dp-payment-grid { grid-template-columns:1fr; gap:6px; }
      .dp-ecfa-logo { height:94px; }
    }
      .dp-payment-chip { min-width:100%; max-width:100%; min-height:90px; padding:8px 12px; }
      .dp-card-type-chip { min-width:70px; padding:6px 10px; }
      .dp-input, .dp-select { padding:10px; font-size:14px; }
      .dp-cta { padding:14px; font-size:16px; }
      .dp-btn-back { width:40px; height:40px; font-size:20px; margin-right:8px; }
      
      /* Smaller address dropdown on very small screens */
      #popup-address-suggestions, #embedded-address-suggestions { 
        max-height:150px !important;
        font-size:14px !important;
      }
    }
  </style>`;
  // Helper function to group amounts into rows with proper "Other" placement
  function groupAmountsIntoRows(amounts) {
    const rows = [];
    const totalAmounts = amounts.length;
    
    // If we have 1-2 amounts, put them with "Other" in one row
    if (totalAmounts <= 2) {
      rows.push([...amounts, 'other']);
      return rows;
    }
    
    // Calculate how to distribute amounts
    const amountRows = Math.ceil(totalAmounts / 3);
    
    // Check if "Other" fits in the last row or needs its own row
    const lastRowSize = totalAmounts % 3;
    const otherNeedsOwnRow = lastRowSize === 0;
    
    // Create rows of amounts (3 per row)
    for (let i = 0; i < totalAmounts; i += 3) {
      const row = amounts.slice(i, i + 3);
      rows.push(row);
    }
    
    // Handle "Other" placement
    if (otherNeedsOwnRow) {
      // "Other" gets its own row
      rows.push(['other']);
    } else {
      // Add "Other" to the last row
      rows[rows.length - 1].push('other');
    }
    
    return rows;
  }

  function donationDetailsHTML(prefix) {
    // Generate amount rows HTML
    const amounts = [500,100,50,25,10];
    const amountRows = groupAmountsIntoRows(amounts);
    
    const amountRowsHTML = amountRows.map((row, index) => {
      const buttonsHTML = row.map(item => {
        if (item === 'other') {
          return `<button type="button" class="dp-chip dp-amount-chip" data-value="custom">Other</button>`;
        } else {
          return `<button type="button" class="dp-chip dp-amount-chip" data-value="${item}">$${item}</button>`;
        }
      }).join('');
      
      return `<div class="dp-row dp-amount-row" data-row="${index}">${buttonsHTML}</div>`;
    }).join('');

    return `
      <div class="dp-step-content active" id="${prefix}-step1">
        <div class="dp-card">
          <div class="dp-title">Donation Details</div>
          <!-- Frequency -->
          <div style="margin-bottom:16px;">
            <label class="dp-label" for="${prefix}-frequency">Frequency</label>
            <div class="dp-frequency-container">
              <div class="dp-row dp-frequency-options">
                <button type="button" class="dp-chip dp-frequency-chip selected" data-frequency="onetime">One-Time</button>
                <button type="button" class="dp-chip dp-frequency-chip" data-frequency="recurring">Recurring</button>
              </div>
              <div id="${prefix}-recurring-stepper" class="dp-recurring-stepper" style="display:none;margin-top:12px;">
                <div class="dp-stepper-container">
                  <button type="button" class="dp-stepper-btn dp-stepper-minus" id="${prefix}-freq-minus">−</button>
                  <div class="dp-stepper-display" id="${prefix}-freq-display">Monthly</div>
                  <button type="button" class="dp-stepper-btn dp-stepper-plus" id="${prefix}-freq-plus">+</button>
                </div>
              </div>
            </div>
            <input type="hidden" id="${prefix}-frequency" value="onetime">
          </div>
          
          <!-- Donation Amount - Multiple Rows -->
          <div style="margin-bottom:16px;">
            <label class="dp-label">Amount</label>
            <div id="${prefix}-amount-row">
              ${amountRowsHTML}
            </div>
            <div id="${prefix}-custom-wrap" style="display:none;margin-top:8px;">
              <input type="number" min="1" step="0.01" id="${prefix}-custom" class="dp-input" placeholder="Enter custom amount">
            </div>
            <div id="${prefix}-amount-error" class="dp-error-message">Please select or enter a donation amount</div>
          </div>

          <!-- Category with Other Field -->
          <div style="margin-bottom:16px;">
            <label class="dp-label" for="${prefix}-category">Category</label>
            <select id="${prefix}-category" class="dp-select">
              <option>General Giving</option>
              <option>Cooking and Culture</option>
              <option>Corporate Sponsor</option>
              <option>Ministry Expansion</option>
              <option>TNND Payment</option>
              <option>Volunteer Application</option>
              <option>Other (specify)</option>
            </select>
            <div id="${prefix}-category-other-wrap" style="display:none;margin-top:8px;">
              <input type="text" id="${prefix}-category-other" class="dp-input" placeholder="Specify">
              <div id="${prefix}-category-error" class="dp-error-message">Please describe what this donation is for</div>
            </div>
          </div>

          <!-- Total Display -->
          <div class="dp-fee-section" style="margin-bottom:20px;">
            <div class="dp-total-container" style="padding:16px; background:#f8f9fa; border-radius:12px; border:2px solid transparent; transition:all 0.3s ease;" id="${prefix}-total-container">
              <div class="dp-total-amount">
                Total: <span id="${prefix}-total-preview">$0.00</span>
              </div>
              <button type="button" class="dp-btn" id="${prefix}-next1">Next</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function personalAndAddressHTML(prefix) {
    return `
      <div class="dp-step-content" id="${prefix}-step2">
        <div class="dp-card dp-personal-info-card">
          <div class="dp-title">Your Information</div>
          
          <!-- Donation Type Selection -->
          <div style="margin-bottom:20px;">
            <div class="dp-row" style="justify-content:center;">
              <button type="button" class="dp-chip dp-donation-type-chip selected" data-donation-type="individual">Individual</button>
              <button type="button" class="dp-chip dp-donation-type-chip" data-donation-type="organization">Organization</button>
            </div>
            <input type="hidden" id="${prefix}-donation-type" value="individual">
          </div>
          
          <!-- Individual Fields -->
          <div id="${prefix}-individual-fields">
            <!-- Row 1: First Name, Last Name -->
            <div class="dp-grid dp-grid-2" style="margin-bottom:16px;">
              <div>
                <label class="dp-label" for="${prefix}-firstname">First Name</label>
                <input class="dp-input" id="${prefix}-firstname" required>
                <div id="${prefix}-firstname-error" class="dp-error-message">Please enter your first name</div>
              </div>
              <div>
                <label class="dp-label" for="${prefix}-lastname">Last Name</label>
                <input class="dp-input" id="${prefix}-lastname" required>
                <div id="${prefix}-lastname-error" class="dp-error-message">Please enter your last name</div>
              </div>
            </div>
          </div>
          
          <!-- Organization Fields -->
          <div id="${prefix}-organization-fields" style="display:none;">
            <!-- Row 1: Organization Name -->
            <div style="margin-bottom:16px;">
              <label class="dp-label" for="${prefix}-organization-name">Organization Name</label>
              <input class="dp-input" id="${prefix}-organization-name" required>
              <div id="${prefix}-organization-name-error" class="dp-error-message">Please enter the organization name</div>
            </div>
          </div>
          
          <!-- Row 2: Email, Phone -->
          <div class="dp-grid dp-grid-2" style="margin-bottom:16px;">
            <div>
              <label class="dp-label" for="${prefix}-email">Email</label>
              <input type="email" class="dp-input" id="${prefix}-email" required>
              <div id="${prefix}-email-error" class="dp-error-message">Please enter a valid email address</div>
            </div>
            <div>
              <label class="dp-label" for="${prefix}-phone">Phone</label>
              <input type="tel" class="dp-input" id="${prefix}-phone" required>
              <div id="${prefix}-phone-error" class="dp-error-message">Please enter your phone number</div>
            </div>
          </div>
          
          <div class="dp-grid" id="${prefix}-address-lookup-row" style="margin-bottom:16px;">
            <div style="position:relative;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                <label class="dp-label" for="${prefix}-address-lookup" style="margin:0;">Address</label>
                <span id="${prefix}-enter-manually" style="font-size:14px;font-weight:700;cursor:pointer;color:${BRAND_PRIMARY};">Enter manually</span>
              </div>
              <input class="dp-input" id="${prefix}-address-lookup" placeholder="Start typing your address..." autocomplete="off">
              <div id="${prefix}-address-suggestions" style="position:absolute;z-index:10001;top:100%;left:0;width:100%;background:#fff;border:1px solid #ddd;border-radius:0 0 10px 10px;box-shadow:0 8px 20px rgba(0,0,0,.08);display:none;max-height:220px;overflow:auto;"></div>
              <div id="${prefix}-address-lookup-error" class="dp-error-message">Please include your address</div>
            </div>
          </div>
          
          <div id="${prefix}-manual-address" style="display:none;">
            <!-- Row 3: Address Line 1, Address Line 2 (optional) -->
            <div class="dp-grid dp-grid-2" style="margin-bottom:12px;">
              <div>
                <label class="dp-label" for="${prefix}-addr1">Address Line 1</label>
                <input class="dp-input" id="${prefix}-addr1">
                <div id="${prefix}-addr1-error" class="dp-error-message">Please enter your address</div>
              </div>
              <div>
                <label class="dp-label" for="${prefix}-addr2">Address Line 2 (optional)</label>
                <input class="dp-input" id="${prefix}-addr2">
              </div>
            </div>
            
            <!-- Row 4: City, State, Zip, Country -->
            <div class="dp-grid dp-grid-4" style="margin-bottom:12px;">
              <div>
                <label class="dp-label" for="${prefix}-city">City</label>
                <input class="dp-input" id="${prefix}-city">
                <div id="${prefix}-city-error" class="dp-error-message">Please enter your city</div>
              </div>
              <div>
                <label class="dp-label" for="${prefix}-state">State</label>
                <select class="dp-select" id="${prefix}-state"></select>
                <div id="${prefix}-state-error" class="dp-error-message">Please enter your state</div>
              </div>
              <div>
                <label class="dp-label" for="${prefix}-zip">Zip Code</label>
                <input class="dp-input" id="${prefix}-zip">
                <div id="${prefix}-zip-error" class="dp-error-message">Please enter your zip code</div>
              </div>
              <div>
                <label class="dp-label" for="${prefix}-country">Country</label>
                <select class="dp-select" id="${prefix}-country"></select>
                <div id="${prefix}-country-error" class="dp-error-message">Please enter your country</div>
              </div>
            </div>
          </div>
          
          <div class="dp-nav-buttons">
            <button type="button" class="dp-btn secondary" id="${prefix}-prev2">Previous</button>
            <button type="button" class="dp-btn" id="${prefix}-next2">Next</button>
          </div>
        </div>
      </div>
    `;
  }

  function tributeHTML(prefix) {
    return `
      <div class="dp-step-content" id="${prefix}-step3">
        <div class="dp-card">
          <div class="dp-title">Tribute Information</div>
          
          <!-- Tribute Type Selection -->
          <div style="margin-bottom:20px;">
            <label class="dp-label">This donation is:</label>
            <div class="dp-row" style="justify-content:center;">
              <button type="button" class="dp-chip dp-tribute-chip selected" data-tribute-type="honor">In Honor</button>
              <button type="button" class="dp-chip dp-tribute-chip" data-tribute-type="memory">In Memory</button>
            </div>
            <input type="hidden" id="${prefix}-tribute-type" value="honor">
          </div>

          <!-- Tribute Person Information -->
          <div class="dp-grid dp-grid-2" style="margin-bottom:16px;">
            <div>
              <label class="dp-label" for="${prefix}-tribute-firstname">First Name</label>
              <input class="dp-input" id="${prefix}-tribute-firstname" required>
              <div id="${prefix}-tribute-firstname-error" class="dp-error-message">Please enter the person's first name</div>
            </div>
            <div>
              <label class="dp-label" for="${prefix}-tribute-lastname">Last Name</label>
              <input class="dp-input" id="${prefix}-tribute-lastname" required>
              <div id="${prefix}-tribute-lastname-error" class="dp-error-message">Please enter the person's last name</div>
            </div>
          </div>

          <!-- Optional Message -->
          <div style="margin-bottom:20px;">
            <label class="dp-label" for="${prefix}-tribute-message">Message (optional)</label>
            <textarea class="dp-input" id="${prefix}-tribute-message" rows="3" placeholder="Enter a message for this tribute..."></textarea>
          </div>

          <div class="dp-nav-buttons">
            <button type="button" class="dp-btn secondary" id="${prefix}-prev3">Previous</button>
            <button type="button" class="dp-btn" id="${prefix}-next3">Next</button>
          </div>
        </div>
      </div>
    `;
  }

  function reviewAndSubmitHTML(prefix) {
    return `
      <div class="dp-step-content" id="${prefix}-step-review">
        <div class="dp-card">
          <div class="dp-title">Review Your Donation</div>
          <div class="dp-summary">
            <div style="flex:1;">
              <div style="display:flex;justify-content:space-between;gap:12px;">
                <div>Amount</div><div id="${prefix}-gift">$0.00</div>
              </div>
              <div style="display:flex;justify-content:space-between;gap:12px;margin-top:6px;">
                <div>Processing fees <span id="${prefix}-fee-label"></span></div><div id="${prefix}-fee">$0.00</div>
              </div>
              <div id="${prefix}-tribute-summary" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid #eee;">
                <div style="font-weight:600;margin-bottom:6px;">Tribute Information:</div>
                <div id="${prefix}-tribute-display"></div>
              </div>
              <div style="font-size:12px;color:#555;margin-top:6px;" id="${prefix}-recur-note"></div>
            </div>
          </div>
          
          <!-- Cover Processing Fees and Payment Method Selection -->
          <div class="dp-card" style="margin-bottom:16px;">
            <div class="dp-fee-checkbox-container" style="margin-bottom:16px;">
              <label class="dp-checkbox-container">
                <input type="checkbox" id="${prefix}-cover-fee" class="dp-checkbox">
                <span style="font-weight:600;">I would like to cover the processing fees</span>
              </label>
            </div>
            
            <!-- Payment Method with Icons - Only shown when covering fees -->
            <div id="${prefix}-payment-method-section" style="display:none;">
              <label class="dp-label">Payment Method</label>
              <div class="dp-payment-grid" id="${prefix}-pm-row">
                <button type="button" class="dp-chip dp-payment-chip" data-method="card">
                  <img src="https://js.stripe.com/v3/fingerprinted/img/card-ce24697297bd3c6a00fdd2fb6f760f0d.svg" alt="Card" width="32" height="32" />
                  <span>Credit/Debit Card</span>
                </button>
                <button type="button" class="dp-chip dp-payment-chip" data-method="ach">
                  <img src="https://js.stripe.com/v3/fingerprinted/img/bank-de5c9ead31505d57120e98291cb20e57.svg" alt="ACH/Bank Transfer" width="32" height="32" />
                  <span>Bank Transfer</span>
                  <small>0.8% (max $5)</small>
                </button>
                <button type="button" class="dp-chip dp-payment-chip" data-method="wallet">
                  <svg width="32" height="32" viewBox="0 0 40 28" fill="none">
                    <rect class="wallet-svg-main" x="2" y="4" width="36" height="20" rx="4" fill="#000"/>
                    <rect class="wallet-svg-main" x="2" y="4" width="36" height="20" rx="4" stroke="#333" stroke-width="2"/>
                    <circle class="wallet-svg-circle" cx="32" cy="14" r="4" fill="#fff"/>
                    <rect class="wallet-svg-bar" x="6" y="10" width="18" height="4" rx="2" fill="#fff"/>
                  </svg>
                  <span>Digital Wallet</span>
                  <div class="dp-wallet-explainer">PayPal, Apple Pay, Google Pay</div>
                  <small>2.2% + $0.30</small>
                </button>
              </div>
              
              <!-- Card Type Selection - Only shown when card is selected -->
              <div id="${prefix}-card-type-section" style="margin-top:12px;display:none;">
                <label class="dp-label">Card Type</label>
                <div class="dp-row dp-card-types" id="${prefix}-card-type-row">
                  <button type="button" class="dp-chip dp-card-type-chip" data-card-type="visa">
                    <svg width="24" height="24" viewBox="0 0 24 16" fill="none">
                      <rect width="24" height="16" rx="2" fill="#1A1F71"/>
                      <text x="12" y="10" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="6" font-weight="bold">VISA</text>
                    </svg>
                    <span>Visa</span>
                    <small>2.2% + $0.30</small>
                  </button>
                  <button type="button" class="dp-chip dp-card-type-chip" data-card-type="mastercard">
                    <svg width="24" height="24" viewBox="0 0 24 16" fill="none">
                      <rect width="24" height="16" rx="2" fill="#EB001B"/>
                      <circle cx="9" cy="8" r="4" fill="#FF5F00" opacity="0.8"/>
                      <circle cx="15" cy="8" r="4" fill="#F79E1B" opacity="0.8"/>
                    </svg>
                    <span>Mastercard</span>
                    <small>2.2% + $0.30</small>
                  </button>
                  <button type="button" class="dp-chip dp-card-type-chip" data-card-type="amex">
                    <svg width="24" height="24" viewBox="0 0 24 16" fill="none">
                      <rect width="24" height="16" rx="2" fill="#006FCF"/>
                      <text x="12" y="10" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="5" font-weight="bold">AMEX</text>
                    </svg>
                    <span>American Express</span>
                    <small>3.5% + $0.30</small>
                  </button>
                  <button type="button" class="dp-chip dp-card-type-chip" data-card-type="other">
                    <svg width="24" height="24" viewBox="0 0 24 16" fill="none">
                      <rect width="24" height="16" rx="2" fill="#666" stroke="#999"/>
                      <text x="12" y="10" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="5" font-weight="bold">OTHER</text>
                    </svg>
                    <span>Other</span>
                    <small>2.2% + $0.30</small>
                  </button>
                </div>
              </div>
            </div>
          </div>
          
          <button type="button" id="${prefix}-submit" class="dp-cta" disabled>Select an amount</button>
          <div style="text-align:center;font-size:14px;color:#666;margin:12px 0 6px 0;">After clicking donate, you will be taken to Stripe to enter your payment information.</div>
          <div class="dp-trust">Secure Payment powered by Stripe</div>
          <div class="dp-trust-logos">
            <!--<svg class="dp-ecfa-logo" viewBox="0 0 504 504" xmlns="http://www.w3.org/2000/svg">
              <title>ECFA Accredited</title>
              <defs><style>.cls-1{stroke:#231f20;}.cls-1,.cls-2{fill:#fff;}.cls-3{fill:#231f20;}</style></defs>
              <ellipse class="cls-2" cx="248.61" cy="251.34" rx="216.84" ry="217.18"/>
              <path class="cls-2" d="M413.6,200.27c-21.84-70.43-87.5-121.59-165.12-121.59s-143.28,51.16-165.13,121.59h330.25Z"/>
              <path class="cls-2" d="M82.93,301.33c21.38,71.2,87.39,123.08,165.55,123.08s144.16-51.88,165.54-123.08H82.93Z"/>
              <path class="cls-3" d="M29.82,251.54c0,120.53,98.06,218.6,218.59,218.6s218.59-98.06,218.59-218.6S368.94,32.96,248.41,32.96,29.82,131.01,29.82,251.54ZM32.82,251.54c0-118.88,96.71-215.58,215.59-215.58s215.59,96.71,215.59,215.58-96.71,215.6-215.59,215.6S32.82,370.42,32.82,251.54Z"/>
              <path class="cls-3" d="M36.95,251.54c0,116.6,94.86,211.46,211.46,211.46s211.46-94.86,211.46-211.46S365.01,40.08,248.41,40.08,36.95,134.94,36.95,251.54ZM46.55,251.54c0-111.31,90.55-201.86,201.86-201.86s201.86,90.55,201.86,201.86-90.55,201.86-201.86,201.86S46.55,362.85,46.55,251.54Z"/>
              <path class="cls-3" d="M109.12,200.27h46.29l-54.23-33.58,62.6,33.58h19.16l-64.79-57.86,73.5,57.86h9.53l-62.1-78.82,70.46,78.82h5.26l-51.46-95.84,59.4,95.84h3.14l-35.7-108.38,43.32,108.38h2.07l-16.79-116.07,24.22,116.07h1.62l3.66-118.67,3.71,118.67h1.62l24.18-116.12-16.76,116.12h2.07l43.3-108.48-35.69,108.48h3.12l59.42-95.98-51.49,95.98h5.22l70.54-79.01-62.19,79.01h9.46l73.69-58.07-64.98,58.07h19.02l62.97-33.82-54.57,33.82h45.92l21.19-6.98-17.47,6.98h23.02c-21.84-70.43-87.5-121.59-165.12-121.59s-143.28,51.16-165.13,121.59h22.17l-16.85-6.73,20.45,6.73Z"/>
              <path class="cls-3" d="M383.19,301.33h-44.18l56.63,35.06-65.36-35.06h-18.07l66.46,59.34-75.38-59.34h-8.83l63.28,80.3-71.77-80.3h-4.74l52.26,97.32-60.31-97.32h-2.72l36.2,109.86-43.91-109.86h-1.71l17.02,117.55-24.53-117.55h-1.28l-3.7,120.15-3.75-120.15h-1.27l-24.49,117.59,16.97-117.59h-1.7l-43.89,109.95,36.17-109.95h-2.7l-60.34,97.45,52.28-97.45h-4.69l-71.87,80.48,63.35-80.48h-8.74l-75.57,59.55,66.63-59.55h-17.91l-65.73,35.3,56.96-35.3h-43.82l-25.68,8.46,21.17-8.46h-27c21.38,71.2,87.39,123.08,165.55,123.08s144.16-51.88,165.54-123.08h-26.44l20.56,8.21-24.95-8.21Z"/>
              <path class="cls-3" d="M81.71,287.8v-74.09h76.95v13.49h-50.9v15.22h35.28v13.36h-35.28v18.13h50.9v13.89h-76.95Z"/>
              <path class="cls-3" d="M205.99,288.85c-10.42,0-20.84-2.65-28.26-7.54-9.62-6.22-14.63-16.27-14.63-30.43s5.21-24.74,15.63-31.09c7.62-4.63,18.23-7.28,29.46-7.28,21.24,0,34.87,8.6,39.28,21.3l-24.44,2.91c-2.81-7.41-7.82-10.85-15.63-10.85-11.62,0-17.23,6.35-17.23,24.48s5.21,25,18.63,25c8.42,0,14.63-3.97,19.24-12.04l21.04,4.1c-8.02,15.08-22.05,21.43-43.09,21.43Z"/>
              <path class="cls-3" d="M284.95,227.34v15.48h40.1v13.5h-40.1v31.49h-26.06v-74.09h77.18v13.63h-51.12Z"/>
              <path class="cls-3" d="M388.55,287.8l-6.21-16.8h-26.66l-6.21,16.8h-27.06l34.08-74.09h25.05l34.27,74.09h-27.26ZM369.11,238.18l-8.22,19.45h16.23l-8.01-19.45Z"/>
              <path class="cls-3" d="M359.33,327.84c-3.03-2-6.79-2.16-10.07-2.16h-68.09v8.51c-.55-2.42-1.71-4.74-4.12-6.35-3.03-2-6.78-2.16-10.07-2.16h-33.28v7.3c-1.49-4.85-5.26-7.3-11.24-7.3h-13.78v6.58c-1.73-4.87-5.88-7.48-12.12-7.48s-10.06,2.51-11.81,7.46c-1.87-4.86-6.36-7.49-13.04-7.46-8.01.03-12.31,4.29-12.81,12.74l-.27-.27-3.54-4.58-1.34-6.99h-13.44l-8.16,42.5h13l.64-5.02,2.58,1.83.49,3.18h12.99l-.77-4.04c2.45,3.89,6.51,4.94,10.13,4.94,6.42,0,11.35-2.69,13.49-7.55,2.08,6.06,7.04,7.55,11.36,7.55,6.37,0,10.73-2.65,12.61-7.43v6.53h12.73v-14.32c.07.27.14.66.19,1.21.11,1.17.11,2.69.11,4.29,0,1.37,0,2.78.06,4.32.06,1.09.33,2.04.55,2.75l.55,1.75h46.14c2.63,0,5.68-.27,8.3-2.22,1.94-1.39,3.22-3.45,3.86-6.13v8.34h12.73v-30h4.7v30h12.73v-25h4.66v25h35.29c2.63,0,5.68-.27,8.3-2.22,2.82-2.02,4.29-5.42,4.34-10.13v-16.65c0-3.85-.52-8.61-4.59-11.34Z"/>
              <path class="cls-1" d="M135.24,365.92l7.2-37.5h9.31l7.16,37.5h-7.81l-1.1-7.3h-6.06l-.92,7.3h-7.77ZM147.09,335.22h-.09l-2.24,16.8h4.48l-2.15-16.8Z"/>
              <path class="cls-1" d="M174.58,341.52v-2.4c0-3.2-1.01-4.85-2.46-4.85-2.41-.05-2.98,1.45-2.98,3.9l-.04,18.55c0,2.1.75,3.35,2.77,3.35,2.63,0,2.85-3.1,2.85-5.4v-3.4h7.73v4.6c0,6.45-3.25,10.95-11.15,10.95-7.11,0-9.88-4.3-9.88-11.95v-15.4c0-8.15,3.29-11.95,10.36-11.95,6.58,0,10.54,3.2,10.54,10.85v3.15h-7.73Z"/>
              <path class="cls-1" d="M199.43,341.52v-2.4c0-3.2-1.01-4.85-2.46-4.85-2.41-.05-2.98,1.45-2.98,3.9l-.04,18.55c0,2.1.75,3.35,2.77,3.35,2.63,0,2.85-3.1,2.85-5.4v-3.4h7.73v4.6c0,6.45-3.25,10.95-11.15,10.95-7.11,0-9.88-4.3-9.88-11.95v-15.4c0-8.15,3.29-11.95,10.36-11.95,6.58,0,10.54,3.2,10.54,10.85v3.15h-7.73Z"/>
              <path class="cls-1" d="M218.97,365.92h-7.73v-37.5h11.28c6.32,0,9.48,2.9,9.48,10.35,0,4-.83,6.85-4.08,8.55v.1c2.15.55,3.69,2.25,3.82,4.85.22,3,.26,9.45.7,11.85.18.5.4.95.75,1.3v.5h-8.43c-.22-.7-.39-1.4-.44-2.15-.13-3.3.04-6.4-.18-8.7-.22-2.3-.83-3.8-2.63-3.95h-2.55v14.8ZM218.97,344.37h2.63c2.24,0,2.77-2.35,2.77-4.65,0-4.45-1.62-4.65-5.4-4.55v9.2Z"/>
              <path class="cls-1" d="M236.27,365.92v-37.5h17.69v7.5h-9.96v6.9h9.66v7.5h-9.66v8.1h10.49v7.5h-18.22Z"/>
              <path class="cls-1" d="M258.66,365.92v-37.5h8.38c2.81,0,6.19.1,8.69,1.75,2.99,2,3.47,5.65,3.47,9.25v16.65c-.04,3.75-1.05,6.5-3.29,8.1-2.02,1.5-4.48,1.75-6.85,1.75h-10.4ZM266.38,359.17c5.18.4,5.22-2,5.09-7v-12.25c-.04-4.4-1.32-4.65-5.09-4.75v24Z"/>
              <path class="cls-1" d="M283.73,365.92v-37.5h7.73v37.5h-7.73Z"/>
              <path class="cls-1" d="M295.1,328.42h20.02v7.5h-6.23v30h-7.73v-30h-6.06v-7.5Z"/>
              <path class="cls-1" d="M318.54,365.92v-37.5h17.69v7.5h-9.97v6.9h9.66v7.5h-9.66v8.1h10.49v7.5h-18.22Z"/>
              <path class="cls-1" d="M340.94,365.92v-37.5h8.38c2.81,0,6.19.1,8.69,1.75,2.99,2,3.47,5.65,3.47,9.25v16.65c-.04,3.75-1.05,6.5-3.29,8.1-2.02,1.5-4.48,1.75-6.85,1.75h-10.4ZM348.66,359.17c5.18.4,5.22-2,5.09-7v-12.25c-.04-4.4-1.32-4.65-5.09-4.75v24Z"/>
            </svg>-->
            <svg class="dp-ecfa-logo" xmlns="http://www.w3.org/2000/svg" id="ACCREDITED" viewBox="0 0 504 504"><defs><style>.cls-1{fill:#325a8b;}.cls-2{fill:#231f20;}.cls-3{fill:#8891b2;}.cls-4{fill:#e3e4eb;stroke:#325a8b;}.cls-5{fill:#fff;}</style></defs><ellipse class="cls-5" cx="248.61" cy="251.34" rx="216.84" ry="217.18"/><path class="cls-3" d="M413.6,200.27c-21.84-70.43-87.5-121.59-165.12-121.59s-143.28,51.16-165.13,121.59h330.25Z"/><path class="cls-3" d="M82.93,301.33c21.38,71.2,87.39,123.08,165.55,123.08s144.16-51.88,165.54-123.08H82.93Z"/><path class="cls-3" d="M413.6,200.27c-21.84-70.43-87.5-121.59-165.12-121.59s-143.28,51.16-165.13,121.59h330.25Z"/><path class="cls-3" d="M82.93,301.33c21.38,71.2,87.39,123.08,165.55,123.08s144.16-51.88,165.54-123.08H82.93Z"/><path class="cls-2" d="M29.82,251.54c0,120.53,98.06,218.6,218.59,218.6s218.59-98.06,218.59-218.6S368.94,32.96,248.41,32.96,29.82,131.01,29.82,251.54ZM32.82,251.54c0-118.88,96.71-215.58,215.59-215.58s215.59,96.71,215.59,215.58-96.71,215.6-215.59,215.6S32.82,370.42,32.82,251.54Z"/><path class="cls-2" d="M36.95,251.54c0,116.6,94.86,211.46,211.46,211.46s211.46-94.86,211.46-211.46S365.01,40.08,248.41,40.08,36.95,134.94,36.95,251.54ZM46.55,251.54c0-111.31,90.55-201.86,201.86-201.86s201.86,90.55,201.86,201.86-90.55,201.86-201.86,201.86S46.55,362.85,46.55,251.54Z"/><path class="cls-1" d="M109.12,200.27h46.29l-54.23-33.58,62.6,33.58h19.16l-64.79-57.86,73.5,57.86h9.53l-62.1-78.82,70.46,78.82h5.26l-51.46-95.84,59.4,95.84h3.14l-35.7-108.38,43.32,108.38h2.07l-16.79-116.07,24.22,116.07h1.62l3.66-118.67,3.71,118.67h1.62l24.18-116.12-16.76,116.12h2.07l43.3-108.48-35.69,108.48h3.12l59.42-95.98-51.49,95.98h5.22l70.54-79.01-62.19,79.01h9.46l73.69-58.07-64.98,58.07h19.02l62.97-33.82-54.57,33.82h45.92l21.19-6.98-17.47,6.98h23.02c-21.84-70.43-87.5-121.59-165.12-121.59s-143.28,51.16-165.13,121.59h22.17l-16.85-6.73,20.45,6.73Z"/><path class="cls-1" d="M383.19,301.33h-44.18l56.63,35.06-65.36-35.06h-18.07l66.46,59.34-75.38-59.34h-8.83l63.28,80.3-71.77-80.3h-4.74l52.26,97.32-60.31-97.32h-2.72l36.2,109.86-43.91-109.86h-1.71l17.02,117.55-24.53-117.55h-1.28l-3.7,120.15-3.75-120.15h-1.27l-24.49,117.59,16.97-117.59h-1.7l-43.89,109.95,36.17-109.95h-2.7l-60.34,97.45,52.28-97.45h-4.69l-71.87,80.48,63.35-80.48h-8.74l-75.57,59.55,66.63-59.55h-17.91l-65.73,35.3,56.96-35.3h-43.82l-25.68,8.46,21.17-8.46h-27c21.38,71.2,87.39,123.08,165.55,123.08s144.16-51.88,165.54-123.08h-26.44l20.56,8.21-24.95-8.21Z"/><path class="cls-2" d="M81.71,287.8v-74.09h76.95v13.49h-50.9v15.22h35.28v13.36h-35.28v18.13h50.9v13.89h-76.95Z"/><path class="cls-2" d="M205.99,288.85c-10.42,0-20.84-2.65-28.26-7.54-9.62-6.22-14.63-16.27-14.63-30.43s5.21-24.74,15.63-31.09c7.62-4.63,18.23-7.28,29.46-7.28,21.24,0,34.87,8.6,39.28,21.3l-24.44,2.91c-2.81-7.41-7.82-10.85-15.63-10.85-11.62,0-17.23,6.35-17.23,24.48s5.21,25,18.63,25c8.42,0,14.63-3.97,19.24-12.04l21.04,4.1c-8.02,15.08-22.05,21.43-43.09,21.43Z"/><path class="cls-2" d="M284.95,227.34v15.48h40.1v13.5h-40.1v31.49h-26.06v-74.09h77.18v13.63h-51.12Z"/><path class="cls-2" d="M388.55,287.8l-6.21-16.8h-26.66l-6.21,16.8h-27.06l34.08-74.09h25.05l34.27,74.09h-27.26ZM369.11,238.18l-8.22,19.45h16.23l-8.01-19.45Z"/><path class="cls-1" d="M359.33,327.84c-3.03-2-6.79-2.16-10.07-2.16h-68.09v8.51c-.55-2.42-1.71-4.74-4.12-6.35-3.03-2-6.78-2.16-10.07-2.16h-33.28v7.3c-1.49-4.85-5.26-7.3-11.24-7.3h-13.78v6.58c-1.73-4.87-5.88-7.48-12.12-7.48s-10.06,2.51-11.81,7.46c-1.87-4.86-6.36-7.49-13.04-7.46-8.01.03-12.31,4.29-12.81,12.74l-.27-.27-3.54-4.58-1.34-6.99h-13.44l-8.16,42.5h13l.64-5.02,2.58,1.83.49,3.18h12.99l-.77-4.04c2.45,3.89,6.51,4.94,10.13,4.94,6.42,0,11.35-2.69,13.49-7.55,2.08,6.06,7.04,7.55,11.36,7.55,6.37,0,10.73-2.65,12.61-7.43v6.53h12.73v-14.32c.07.27.14.66.19,1.21.11,1.17.11,2.69.11,4.29,0,1.37,0,2.78.06,4.32.06,1.09.33,2.04.55,2.75l.55,1.75h46.14c2.63,0,5.68-.27,8.3-2.22,1.94-1.39,3.22-3.45,3.86-6.13v8.34h12.73v-30h4.7v30h12.73v-25h4.66v25h35.29c2.63,0,5.68-.27,8.3-2.22,2.82-2.02,4.29-5.42,4.34-10.13v-16.65c0-3.85-.52-8.61-4.59-11.34Z"/><path class="cls-4" d="M135.24,365.92l7.2-37.5h9.31l7.16,37.5h-7.81l-1.1-7.3h-6.06l-.92,7.3h-7.77ZM147.09,335.22h-.09l-2.24,16.8h4.48l-2.15-16.8Z"/><path class="cls-4" d="M174.58,341.52v-2.4c0-3.2-1.01-4.85-2.46-4.85-2.41-.05-2.98,1.45-2.98,3.9l-.04,18.55c0,2.1.75,3.35,2.77,3.35,2.63,0,2.85-3.1,2.85-5.4v-3.4h7.73v4.6c0,6.45-3.25,10.95-11.15,10.95-7.11,0-9.88-4.3-9.88-11.95v-15.4c0-8.15,3.29-11.95,10.36-11.95,6.58,0,10.54,3.2,10.54,10.85v3.15h-7.73Z"/><path class="cls-4" d="M199.43,341.52v-2.4c0-3.2-1.01-4.85-2.46-4.85-2.41-.05-2.98,1.45-2.98,3.9l-.04,18.55c0,2.1.75,3.35,2.77,3.35,2.63,0,2.85-3.1,2.85-5.4v-3.4h7.73v4.6c0,6.45-3.25,10.95-11.15,10.95-7.11,0-9.88-4.3-9.88-11.95v-15.4c0-8.15,3.29-11.95,10.36-11.95,6.58,0,10.54,3.2,10.54,10.85v3.15h-7.73Z"/><path class="cls-4" d="M218.97,365.92h-7.73v-37.5h11.28c6.32,0,9.48,2.9,9.48,10.35,0,4-.83,6.85-4.08,8.55v.1c2.15.55,3.69,2.25,3.82,4.85.22,3,.26,9.45.7,11.85.18.5.4.95.75,1.3v.5h-8.43c-.22-.7-.39-1.4-.44-2.15-.13-3.3.04-6.4-.18-8.7-.22-2.3-.83-3.8-2.63-3.95h-2.55v14.8ZM218.97,344.37h2.63c2.24,0,2.77-2.35,2.77-4.65,0-4.45-1.62-4.65-5.4-4.55v9.2Z"/><path class="cls-4" d="M236.27,365.92v-37.5h17.69v7.5h-9.96v6.9h9.66v7.5h-9.66v8.1h10.49v7.5h-18.22Z"/><path class="cls-4" d="M258.66,365.92v-37.5h8.38c2.81,0,6.19.1,8.69,1.75,2.99,2,3.47,5.65,3.47,9.25v16.65c-.04,3.75-1.05,6.5-3.29,8.1-2.02,1.5-4.48,1.75-6.85,1.75h-10.4ZM266.38,359.17c5.18.4,5.22-2,5.09-7v-12.25c-.04-4.4-1.32-4.65-5.09-4.75v24Z"/><path class="cls-4" d="M283.73,365.92v-37.5h7.73v37.5h-7.73Z"/><path class="cls-4" d="M295.1,328.42h20.02v7.5h-6.23v30h-7.73v-30h-6.06v-7.5Z"/><path class="cls-4" d="M318.54,365.92v-37.5h17.69v7.5h-9.97v6.9h9.66v7.5h-9.66v8.1h10.49v7.5h-18.22Z"/><path class="cls-4" d="M340.94,365.92v-37.5h8.38c2.81,0,6.19.1,8.69,1.75,2.99,2,3.47,5.65,3.47,9.25v16.65c-.04,3.75-1.05,6.5-3.29,8.1-2.02,1.5-4.48,1.75-6.85,1.75h-10.4ZM348.66,359.17c5.18.4,5.22-2,5.09-7v-12.25c-.04-4.4-1.32-4.65-5.09-4.75v24Z"/></svg>
          </div>
        </div>
      </div>
    `;
  }

  function headerHTML(prefix, embedded) {
    return `
      <div class="${embedded ? "dp-embedded" : ""}">
        <div class="dp-panel">
          <div class="dp-header">
            <button type="button" class="dp-btn-back" id="${prefix}-header-back" aria-label="Go back" style="display:none;">←</button>
            <img src="https://images.squarespace-cdn.com/content/v1/5af0bc3a96d45593d7d7e55b/c8c56eb8-9c50-4540-822a-5da3f5d0c268/refuge-logo-edit+%28circle+with+horizontal+RI+name%29+-+small.png" alt="Refuge International"/>
            ${embedded ? "" : `<button class="dp-close" id="${prefix}-close" aria-label="Close">&times;</button>`}
          </div>
          <div class="dp-body" id="${prefix}-body">
            <div class="dp-steps" id="${prefix}-step-indicators">
              <div class="dp-step active" id="${prefix}-step-indicator-1"></div>
              <div class="dp-step" id="${prefix}-step-indicator-2"></div>
              <div class="dp-step" id="${prefix}-step-indicator-3"></div>
              <div class="dp-step" id="${prefix}-step-indicator-4" style="display:none;"></div>
            </div>
            ${donationDetailsHTML(prefix)}
            ${personalAndAddressHTML(prefix)}
            ${tributeHTML(prefix)}
            ${reviewAndSubmitHTML(prefix)}
          </div>
        </div>
      </div>
    `;
  }

  function mountPopup() {
    var root = document.getElementById("donation-popup");
    if (!root) return;

    if (!document.getElementById("donation-popup-style")) {
      document.head.insertAdjacentHTML("beforeend", style);
    }

    root.innerHTML = `
      <div class="dp-modal" id="dp-modal">
        ${headerHTML("popup", false)}
      </div>
    `;

    var modal = document.getElementById("dp-modal");
    var closeBtn = document.getElementById("popup-close");
    var currentParams = null;
    function showModal(params) { 
      modal.style.display = "flex"; 
      currentParams = params;
    }
    function hideModal() { modal.style.display = "none"; history.pushState("", document.title, window.location.pathname + window.location.search); }

    function checkHash() { 
      if (window.location.hash.startsWith("#donate")) {
        // Parse parameters from hash
        var hash = window.location.hash;
        var params = {};
        if (hash.includes('?')) {
          var queryString = hash.split('?')[1];
          var urlParams = new URLSearchParams(queryString);
          for (var pair of urlParams.entries()) {
            params[pair[0]] = decodeURIComponent(pair[1]);
          }
        }
        showModal(params);
      }
    }
    checkHash();
    window.addEventListener("hashchange", checkHash);

    modal.addEventListener("click", function (e) {
      if (e.target === modal) hideModal();
    });
    if (closeBtn) closeBtn.addEventListener("click", hideModal);

    wireUp("popup", currentParams);
  }

  function mountEmbedded() {
    var root = document.getElementById("donation-form-embedded");
    if (!root) return;

    if (!document.getElementById("donation-popup-style")) {
      document.head.insertAdjacentHTML("beforeend", style);
    }

    root.innerHTML = headerHTML("embedded", true);
    wireUp("embedded", null);
  }

  function populateSelect(id, options) {
    var sel = document.getElementById(id);
    if (!sel) return;
    options.forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    });
  }

  function wireUp(prefix, params) {
    var currentStep = 1;
    var totalSteps = 3;
    var isTributeSelected = false;
    
    // Category configuration - easily adjustable mapping of frequency to categories
    var categoryConfig = {
      onetime: [
        "General Giving",
        "Cooking and Culture",
        "Corporate Sponsor",
        "Ministry Expansion Campaign",
        "TNND Payment", 
        "Volunteer Application",
        //"Tribute",
        "Other (specify)"
      ],
      recurring: [
        "General Giving",
        "Corporate Sponsor",
        //"Tribute",
        "Other (specify)"
      ]
    };
    
    function setCategoryFromParams(params) {
      if (!params || !params.campaignName) return;
      
      var catSel = document.getElementById(prefix + "-category");
      var catOtherInput = document.getElementById(prefix + "-category-other");
      var catOtherWrap = document.getElementById(prefix + "-category-other-wrap");
      
      if (!catSel) return;
      
      // Get all current options
      var currentOptions = Array.from(catSel.options).map(option => option.value);
      
      // Check if campaignName is in available categories
      var campaignName = params.campaignName.trim();
      var categoryExists = currentOptions.includes(campaignName);
      
      if (categoryExists) {
        // Set the category directly
        catSel.value = campaignName;
      } else {
        // Set to "Other (specify)" and populate the other field
        catSel.value = "Other (specify)";
        if (catOtherInput) {
          catOtherInput.value = campaignName;
        }
        if (catOtherWrap) {
          catOtherWrap.style.display = "";
        }
      }
      
      // Trigger change event to update UI
      var changeEvent = new Event('change');
      catSel.dispatchEvent(changeEvent);
    }
    
    function updateStepStructure() {
      var step4Indicator = document.getElementById(prefix + "-step-indicator-4");
      
      if (isTributeSelected) {
        totalSteps = 4;
        if (step4Indicator) step4Indicator.style.display = "block";
      } else {
        totalSteps = 3;
        if (step4Indicator) step4Indicator.style.display = "none";
      }
    }
    
    function showStep(step) {
      // Hide all steps first
      document.getElementById(prefix + "-step1").classList.remove("active");
      document.getElementById(prefix + "-step2").classList.remove("active");
      
      var tributeStep = document.getElementById(prefix + "-step3");
      var reviewStep = document.getElementById(prefix + "-step-review");
      
      if (tributeStep) tributeStep.classList.remove("active");
      if (reviewStep) reviewStep.classList.remove("active");
      
      // Update step indicators
      for (var i = 1; i <= 4; i++) {
        var indicatorEl = document.getElementById(prefix + "-step-indicator-" + i);
        if (indicatorEl) {
          indicatorEl.classList.remove("active", "completed");
          if (i < step) indicatorEl.classList.add("completed");
          else if (i === step) indicatorEl.classList.add("active");
        }
      }
      
      // Show the appropriate step content
      var targetStepEl;
      if (step === 1) {
        targetStepEl = document.getElementById(prefix + "-step1");
      } else if (step === 2) {
        targetStepEl = document.getElementById(prefix + "-step2");
      } else if (step === 3) {
        if (isTributeSelected) {
          // Step 3 is tribute information when tribute is selected
          targetStepEl = tributeStep;
        } else {
          // Step 3 is review when tribute is not selected
          targetStepEl = reviewStep;
        }
      } else if (step === 4 && isTributeSelected) {
        // Step 4 is review when tribute is selected
        targetStepEl = reviewStep;
      }
      
      if (targetStepEl) targetStepEl.classList.add("active");
      
      var headerBackBtn = document.getElementById(prefix + "-header-back");
      var actualTotalSteps = isTributeSelected ? 4 : 3;
      if (headerBackBtn) {
        if (step === actualTotalSteps) {
          headerBackBtn.style.display = "block";
        } else {
          headerBackBtn.style.display = "none";
        }
      }
      
      currentStep = step;
    }
    
    function validateStep(step) {
      switch(step) {
        case 1:
          var amountOk = customActive ? (parseFloat(customInput.value || "0") > 0) : (selectedAmount > 0);
          var category = document.getElementById(prefix + "-category").value;
          var otherOk = true;
          var categoryError = document.getElementById(prefix + "-category-error");
          var amountError = document.getElementById(prefix + "-amount-error");
          
          // Amount validation
          if (!amountOk && amountError) {
            amountError.style.display = "block";
          } else if (amountError) {
            amountError.style.display = "none";
          }
          
          // Category validation
          if (category === "Other (specify)") {
            var otherValue = document.getElementById(prefix + "-category-other").value.trim();
            otherOk = otherValue.length > 0;
            if (!otherOk && categoryError) {
              categoryError.style.display = "block";
            } else if (categoryError) {
              categoryError.style.display = "none";
            }
          } else if (categoryError) {
            categoryError.style.display = "none";
          }
          
          return amountOk && otherOk;
        case 2:
          var donationType = document.getElementById(prefix + "-donation-type").value;
          var email = document.getElementById(prefix + "-email").value.trim();
          var phone = document.getElementById(prefix + "-phone").value.trim();
          var manualWrap = document.getElementById(prefix + "-manual-address");
          var lookupInput = document.getElementById(prefix + "-address-lookup");
          var addr1 = document.getElementById(prefix + "-addr1");
          var city = document.getElementById(prefix + "-city");
          var stateSel = document.getElementById(prefix + "-state");
          var zip = document.getElementById(prefix + "-zip");
          var countrySel = document.getElementById(prefix + "-country");
          
          // Validate based on donation type
          var identityOk = false;
          if (donationType === "individual") {
            // Individual validation
            var fname = document.getElementById(prefix + "-firstname").value.trim();
            var lname = document.getElementById(prefix + "-lastname").value.trim();
            
            var fnameError = document.getElementById(prefix + "-firstname-error");
            var lnameError = document.getElementById(prefix + "-lastname-error");
            
            var fnameOk = fname.length > 0;
            var lnameOk = lname.length > 0;
            
            // Show/hide error messages for individual
            if (fnameError) fnameError.style.display = fnameOk ? "none" : "block";
            if (lnameError) lnameError.style.display = lnameOk ? "none" : "block";
            
            identityOk = fnameOk && lnameOk;
          } else {
            // Organization validation
            var orgName = document.getElementById(prefix + "-organization-name").value.trim();
            var orgNameError = document.getElementById(prefix + "-organization-name-error");
            
            var orgNameOk = orgName.length > 0;
            
            // Show/hide error messages for organization
            if (orgNameError) orgNameError.style.display = orgNameOk ? "none" : "block";
            
            identityOk = orgNameOk;
          }
          
          // Common field validation (email, phone)
          var emailError = document.getElementById(prefix + "-email-error");
          var phoneError = document.getElementById(prefix + "-phone-error");
          
          var emailOk = /.+@.+\..+/.test(email);
          var phoneOk = phone.length > 0;
          
          // Show/hide error messages for common fields
          if (emailError) emailError.style.display = emailOk ? "none" : "block";
          if (phoneError) phoneError.style.display = phoneOk ? "none" : "block";
          
          identityOk = identityOk && emailOk && phoneOk;
          
          // Address validation with error messages
          var hasManualAddressData = addr1.value.trim() || city.value.trim() || stateSel.value.trim() || zip.value.trim() || countrySel.value.trim();
          var isManualAddress = manualWrap.style.display !== "none" || hasManualAddressData;
          var addressOk = false;
          
          if (isManualAddress) {
            // Manual address validation
            var addr1Ok = addr1.value.trim().length > 0;
            var cityOk = city.value.trim().length > 0;
            var stateOk = stateSel.value.length > 0;
            var zipOk = zip.value.trim().length > 0;
            var countryOk = countrySel.value.length > 0;
            
            // Show/hide error messages for manual address
            var addr1Error = document.getElementById(prefix + "-addr1-error");
            var cityError = document.getElementById(prefix + "-city-error");
            var stateError = document.getElementById(prefix + "-state-error");
            var zipError = document.getElementById(prefix + "-zip-error");
            var countryError = document.getElementById(prefix + "-country-error");
            
            if (addr1Error) addr1Error.style.display = addr1Ok ? "none" : "block";
            if (cityError) cityError.style.display = cityOk ? "none" : "block";
            if (stateError) stateError.style.display = stateOk ? "none" : "block";
            if (zipError) zipError.style.display = zipOk ? "none" : "block";
            if (countryError) countryError.style.display = countryOk ? "none" : "block";
            
            addressOk = addr1Ok && cityOk && stateOk && zipOk && countryOk;
            
            // Hide lookup error if manual address is being used
            var lookupError = document.getElementById(prefix + "-address-lookup-error");
            if (lookupError) lookupError.style.display = "none";
          } else {
            // Address lookup validation
            var lookupOk = lookupInput.value.trim().length >= 5;
            var lookupError = document.getElementById(prefix + "-address-lookup-error");
            
            if (lookupError) lookupError.style.display = lookupOk ? "none" : "block";
            
            addressOk = lookupOk;
            
            // Hide manual address errors if lookup is being used
            var manualErrors = [
              document.getElementById(prefix + "-addr1-error"),
              document.getElementById(prefix + "-city-error"),
              document.getElementById(prefix + "-state-error"),
              document.getElementById(prefix + "-zip-error"),
              document.getElementById(prefix + "-country-error")
            ];
            
            manualErrors.forEach(function(errorEl) {
              if (errorEl) errorEl.style.display = "none";
            });
          }
          
          return identityOk && addressOk;
        case 3:
          // If tribute is not selected, this is the review step, so validation passes
          if (!isTributeSelected) return true;
          
          // Tribute validation
          var tributeFirstName = document.getElementById(prefix + "-tribute-firstname").value.trim();
          var tributeLastName = document.getElementById(prefix + "-tribute-lastname").value.trim();
          
          var tributeFirstNameError = document.getElementById(prefix + "-tribute-firstname-error");
          var tributeLastNameError = document.getElementById(prefix + "-tribute-lastname-error");
          
          var tributeFirstNameOk = tributeFirstName.length > 0;
          var tributeLastNameOk = tributeLastName.length > 0;
          
          if (tributeFirstNameError) tributeFirstNameError.style.display = tributeFirstNameOk ? "none" : "block";
          if (tributeLastNameError) tributeLastNameError.style.display = tributeLastNameOk ? "none" : "block";
          
          return tributeFirstNameOk && tributeLastNameOk;
        default:
          return true;
      }
    }
    
    function updateCategoryOptions(frequency) {
      var catSel = document.getElementById(prefix + "-category");
      if (!catSel) return;
      
      var currentValue = catSel.value;
      var categories = categoryConfig[frequency] || categoryConfig.onetime;
      
      // Clear existing options
      catSel.innerHTML = "";
      
      // Add new options based on frequency
      categories.forEach(function(category) {
        var option = document.createElement("option");
        option.value = category;
        option.textContent = category;
        catSel.appendChild(option);
      });
      
      // Try to preserve the current selection if it exists in the new list
      var optionExists = categories.indexOf(currentValue) !== -1;
      if (optionExists) {
        catSel.value = currentValue;
      } else {
        // Default to first option if current selection doesn't exist
        catSel.value = categories[0] || "";
      }
      
      // Trigger change event to update "Other" field visibility
      var changeEvent = new Event('change');
      catSel.dispatchEvent(changeEvent);
    }
    
    function setupStepNavigation() {
      // Setup navigation for all possible steps (1-4)
      for (var i = 1; i <= 4; i++) {
        var nextBtn = document.getElementById(prefix + "-next" + i);
        var prevBtn = document.getElementById(prefix + "-prev" + i);
        
        if (nextBtn) {
          nextBtn.addEventListener("click", (function(step) {
            return function() {
              if (validateStep(step)) {
                var nextStep = step + 1;
                var maxSteps = isTributeSelected ? 4 : 3;
                
                if (nextStep <= maxSteps) {
                  showStep(nextStep);
                  updateTotals();
                }
              }
            };
          })(i));
        }
        
        if (prevBtn) {
          prevBtn.addEventListener("click", (function(step) {
            return function() {
              var prevStep = step - 1;
              
              if (prevStep >= 1) {
                showStep(prevStep);
              }
            };
          })(i));
        }
      }
    }
    
    populateSelect(prefix + "-state", states);
    populateSelect(prefix + "-country", countries);

    setupStepNavigation();
    
    // Initialize category options for default frequency (One-Time)
    updateCategoryOptions("onetime");
    
    var headerBackBtn = document.getElementById(prefix + "-header-back");
    if (headerBackBtn) {
      headerBackBtn.addEventListener("click", function() {
        if (currentStep > 1) {
          showStep(currentStep - 1);
        }
      });
    }

    var amountRow = document.getElementById(prefix + "-amount-row");
    var customWrap = document.getElementById(prefix + "-custom-wrap");
    var customInput = document.getElementById(prefix + "-custom");
    var totalPreview = document.getElementById(prefix + "-total-preview");
    var selectedAmount = 0; // no default selection
    var customActive = false;

    function selectChipGroup(row, valueAttr, value) {
      var btns = row.querySelectorAll(".dp-chip");
      btns.forEach(function (b) { b.classList.remove("selected"); });
      var target = Array.prototype.find.call(btns, function (b) { return b.getAttribute(valueAttr) === value; });
      if (target) target.classList.add("selected");
    }

    amountRow.addEventListener("click", function (e) {
      var t = e.target.closest(".dp-chip");
      if (!t) return;
      var v = t.getAttribute("data-value");
      
      // Clear amount error when user selects an amount
      var amountError = document.getElementById(prefix + "-amount-error");
      if (amountError) amountError.style.display = "none";
      
      if (v === "custom") {
        customActive = true;
        customWrap.style.display = "";
        selectChipGroup(amountRow, "data-value", "custom");
        customInput.focus();
      } else {
        customActive = false;
        customWrap.style.display = "none";
        selectedAmount = parseFloat(v);
        selectChipGroup(amountRow, "data-value", v);
        updateTotals();
      }
    });

    if (!customActive) { // no default selection
      // selectChipGroup(amountRow, "data-value", "100");
    }

    customInput.addEventListener("input", updateTotals);

    // frequency handling with elegant stepper system
    var freqHidden = document.getElementById(prefix + "-frequency");
    var frequencyOptions = document.querySelector("#" + prefix + "-step1 .dp-frequency-options");
    var recurringStepper = document.getElementById(prefix + "-recurring-stepper");
    var freqDisplay = document.getElementById(prefix + "-freq-display");
    var freqMinus = document.getElementById(prefix + "-freq-minus");
    var freqPlus = document.getElementById(prefix + "-freq-plus");
    
    // Frequency options: Weekly → Bi-Weekly → Monthly → Yearly
    var recurringFreqs = [
      { value: "year", label: "Yearly" },
      { value: "month", label: "Monthly" },
      { value: "biweek", label: "Bi-Weekly" },
      { value: "week", label: "Weekly" }
    ];
    var currentFreqIndex = 1; // Default to Monthly (index 1)
    
    function updateStepperDisplay() {
      var current = recurringFreqs[currentFreqIndex];
      freqDisplay.textContent = current.label;
      freqHidden.value = current.value;
      
      // Update button states
      freqMinus.disabled = currentFreqIndex === 0; // Disable at Bi-Weekly
      freqPlus.disabled = currentFreqIndex === recurringFreqs.length - 1; // Disable at Yearly
      
      updateTotals();
    }
    
    // Handle frequency option selection (One-Time vs Recurring)
    frequencyOptions.addEventListener("click", function (e) {
      var t = e.target.closest(".dp-frequency-chip");
      if (!t) return;
      var freq = t.getAttribute("data-frequency");
      
      frequencyOptions.querySelectorAll(".dp-frequency-chip").forEach(function(chip) {
        chip.classList.remove("selected");
      });
      t.classList.add("selected");
      
      // Show/hide recurring stepper
      if (freq === "recurring") {
        recurringStepper.style.display = "block";
        currentFreqIndex = 1; // Reset to Monthly when switching to recurring
        updateStepperDisplay();
        updateCategoryOptions("recurring");
      } else {
        recurringStepper.style.display = "none";
        freqHidden.value = "onetime";
        updateCategoryOptions("onetime");
        updateTotals();
      }
    });
    
    // Handle stepper button clicks
    freqMinus.addEventListener("click", function() {
      if (currentFreqIndex > 0) {
        currentFreqIndex--;
        updateStepperDisplay();
      }
    });
    
    freqPlus.addEventListener("click", function() {
      if (currentFreqIndex < recurringFreqs.length - 1) {
        currentFreqIndex++;
        updateStepperDisplay();
      }
    });

    var freqSel = freqHidden; // Keep reference for compatibility
    // category + other
    var catSel = document.getElementById(prefix + "-category");
    var catOtherWrap = document.getElementById(prefix + "-category-other-wrap");
    var catOtherInput = document.getElementById(prefix + "-category-other");
    catSel.addEventListener("change", function () {
      var isOther = catSel.value.indexOf("Other") === 0 || catSel.value.indexOf("Other (specify)") === 0;
      var wasTributeSelected = isTributeSelected;
      isTributeSelected = catSel.value === "Tribute";
      
      catOtherWrap.style.display = isOther ? "" : "none";
      var categoryError = document.getElementById(prefix + "-category-error");
      if (categoryError) {
        categoryError.style.display = "none";
      }
      
      // Update step structure if tribute selection changed
      if (wasTributeSelected !== isTributeSelected) {
        updateStepStructure();
        // If we're currently past step 2 and tribute selection changed, 
        // navigate to the appropriate step
        if (currentStep > 2) {
          if (isTributeSelected) {
            // Tribute was just selected, go to tribute step (step 3)
            showStep(3);
          } else {
            // Tribute was deselected, go to review step (step 3 when no tribute)
            showStep(3);
          }
        }
      }
      
      updateTotals();
    });

    var coverFee = document.getElementById(prefix + "-cover-fee");
    var paymentMethodSection = document.getElementById(prefix + "-payment-method-section");
    
    coverFee.addEventListener("change", function() {
      if (coverFee.checked) {
        paymentMethodSection.style.display = "block";
      } else {
        paymentMethodSection.style.display = "none";
      }
      updateTotals();
    });

    var pmRow = document.getElementById(prefix + "-pm-row");
    pmRow.addEventListener("click", function (e) {
      var t = e.target.closest(".dp-chip");
      if (!t) return;
      paymentMethod = t.getAttribute("data-method");
      selectChipGroup(pmRow, "data-method", paymentMethod);
      
      // Show/hide card type selection based on payment method
      var cardTypeSection = document.getElementById(prefix + "-card-type-section");
      if (paymentMethod === "card") {
        cardTypeSection.style.display = "block";
        // Reset to default card type if not already selected
        if (!cardType) {
          cardType = "visa";
          var cardTypeRow = document.getElementById(prefix + "-card-type-row");
          selectChipGroup(cardTypeRow, "data-card-type", cardType);
        }
      } else {
        cardTypeSection.style.display = "none";
        cardType = null;
      }
      
      updateTotals();
      
      // Improve UX: Highlight the Next button and total container after payment method selection
      var nextBtn = document.getElementById(prefix + "-next1");
      var totalContainer = document.getElementById(prefix + "-total-container");
      
      if (nextBtn) {
        // Add a subtle animation to draw attention to the Next button
        nextBtn.style.transform = "scale(1.05)";
        nextBtn.style.boxShadow = "0 4px 20px rgba(189,33,53,.4)";
        setTimeout(function() {
          nextBtn.style.transform = "scale(1)";
          nextBtn.style.boxShadow = "";
        }, 1500);
        
        // Smooth scroll to ensure the Next button is visible
        nextBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      
      if (totalContainer) {
        // Highlight the total container to show where to proceed
        totalContainer.style.borderColor = "var(--brand)";
        totalContainer.style.backgroundColor = "#fff";
        setTimeout(function() {
          totalContainer.style.borderColor = "transparent";
          totalContainer.style.backgroundColor = "#f8f9fa";
        }, 2000);
      }
    });
    
    var paymentMethod = "card";
    var cardType = "visa"; // Default card type
    
    // Card type selection
    var cardTypeRow = document.getElementById(prefix + "-card-type-row");
    if (cardTypeRow) {
      cardTypeRow.addEventListener("click", function (e) {
        var t = e.target.closest(".dp-chip");
        if (!t) return;
        cardType = t.getAttribute("data-card-type");
        selectChipGroup(cardTypeRow, "data-card-type", cardType);
        updateTotals();
      });
    }
    
    // Set default selections
    selectChipGroup(pmRow, "data-method", "card");
    if (cardTypeRow) {
      selectChipGroup(cardTypeRow, "data-card-type", "visa");
      // Show card type section by default since card is selected
      var cardTypeSection = document.getElementById(prefix + "-card-type-section");
      cardTypeSection.style.display = "block";
    }

    // Tribute option selection
    var tributeTypeHidden = document.getElementById(prefix + "-tribute-type");
    var tributeOptionsRow = document.querySelector("#" + prefix + "-step3 .dp-row");
    if (tributeOptionsRow) {
      tributeOptionsRow.addEventListener("click", function (e) {
        var t = e.target.closest(".dp-tribute-chip");
        if (!t) return;
        var tributeType = t.getAttribute("data-tribute-type");
        
        tributeOptionsRow.querySelectorAll(".dp-tribute-chip").forEach(function(chip) {
          chip.classList.remove("selected");
        });
        t.classList.add("selected");
        
        if (tributeTypeHidden) {
          tributeTypeHidden.value = tributeType;
        }
        
        updateTributeDisplay();
      });
    }

    // Donation type selection (Individual vs Organization)
    var donationTypeHidden = document.getElementById(prefix + "-donation-type");
    var donationTypeRow = document.querySelector("#" + prefix + "-step2 .dp-row");
    var individualFields = document.getElementById(prefix + "-individual-fields");
    var organizationFields = document.getElementById(prefix + "-organization-fields");
    
    if (donationTypeRow) {
      donationTypeRow.addEventListener("click", function (e) {
        var t = e.target.closest(".dp-donation-type-chip");
        if (!t) return;
        var donationType = t.getAttribute("data-donation-type");
        
        donationTypeRow.querySelectorAll(".dp-donation-type-chip").forEach(function(chip) {
          chip.classList.remove("selected");
        });
        t.classList.add("selected");
        
        if (donationTypeHidden) {
          donationTypeHidden.value = donationType;
        }
        
        // Show/hide appropriate fields
        if (donationType === "individual") {
          individualFields.style.display = "block";
          organizationFields.style.display = "none";
        } else {
          individualFields.style.display = "none";
          organizationFields.style.display = "block";
        }
        
        // Clear error messages when switching
        clearFieldErrors();
      });
    }

    // address lookup / manual
    var lookupRow = document.getElementById(prefix + "-address-lookup-row");
    var lookupInput = document.getElementById(prefix + "-address-lookup");
    var suggestions = document.getElementById(prefix + "-address-suggestions");
    var enterManual = document.getElementById(prefix + "-enter-manually");
    var manualWrap = document.getElementById(prefix + "-manual-address");

    var addr1 = document.getElementById(prefix + "-addr1");
    var addr2 = document.getElementById(prefix + "-addr2");
    var city = document.getElementById(prefix + "-city");
    var stateSel = document.getElementById(prefix + "-state");
    var zip = document.getElementById(prefix + "-zip");
    var countrySel = document.getElementById(prefix + "-country");

    var lookupTimeout = null;
    lookupInput.addEventListener("input", function () {
      var val = lookupInput.value.trim();
      if (val.length < 5) { suggestions.style.display = "none"; suggestions.innerHTML = ""; return; }
      if (lookupTimeout) clearTimeout(lookupTimeout);
      lookupTimeout = setTimeout(function () {
        fetch("https://nominatim.openstreetmap.org/search?q=" + encodeURIComponent(val) + "&format=json&addressdetails=1&limit=5&countrycodes=us")
          .then(function (r) { return r.json(); })
          .then(function (res) {
            suggestions.innerHTML = "";
            if (!res || !res.length) { suggestions.style.display = "none"; return; }
            res.forEach(function (item) {
              var div = document.createElement("div");
              div.textContent = item.display_name;
              div.style.padding = "10px 12px";
              div.style.cursor = "pointer";
              div.addEventListener("mouseenter", function(){ div.style.background = "#f7f7f7"; });
              div.addEventListener("mouseleave", function(){ div.style.background = "#fff"; });
              div.addEventListener("click", function () {
                lookupInput.value = item.display_name;
                var a = item.address || {};
                addr1.value = (a.house_number ? a.house_number + " " : "") + (a.road || a.pedestrian || a.footway || a.cycleway || a.path || "");
                city.value = a.city || a.town || a.village || a.hamlet || "";
                zip.value = a.postcode || "";
                // best-effort state match
                var stateName = a.state || "";
                var stateOpt = states.find(function (s) { return stateName && s.toLowerCase().indexOf(stateName.toLowerCase()) >= 0; }) || "";
                stateSel.value = stateOpt;
                countrySel.value = countries.find(function (c) { return c === (a.country || "United States"); }) || "United States";
                suggestions.style.display = "none";
                manualWrap.style.display = "";
                lookupRow.style.display = "none";
              });
              suggestions.appendChild(div);
            });
            suggestions.style.display = "block";
          })
          .catch(function () { suggestions.style.display = "none"; });
      }, 300);
    });

    document.addEventListener("click", function (e) {
      if (!lookupRow.contains(e.target)) suggestions.style.display = "none";
    });

    enterManual.addEventListener("click", function () {
      manualWrap.style.display = "";
      lookupRow.style.display = "none";
    });

    // summary + submit
    var giftEl = document.getElementById(prefix + "-gift");
    var feeEl = document.getElementById(prefix + "-fee");
    var feeLabel = document.getElementById(prefix + "-fee-label");
    var totalEl = null; // No separate total element, total is shown in button text
    var recurNote = document.getElementById(prefix + "-recur-note");
    var submitBtn = document.getElementById(prefix + "-submit");

    function format(n) { return "$" + (Number(n || 0).toFixed(2)); }

    function updateTributeDisplay() {
      var tributeSummary = document.getElementById(prefix + "-tribute-summary");
      var tributeDisplay = document.getElementById(prefix + "-tribute-display");
      
      if (!tributeSummary || !tributeDisplay) return;
      
      if (isTributeSelected) {
        var tributeType = document.getElementById(prefix + "-tribute-type").value;
        var tributeFirstName = document.getElementById(prefix + "-tribute-firstname").value.trim();
        var tributeLastName = document.getElementById(prefix + "-tribute-lastname").value.trim();
        var tributeMessage = document.getElementById(prefix + "-tribute-message").value.trim();
        
        if (tributeFirstName && tributeLastName) {
          var displayText = (tributeType === "honor" ? "In Honor of: " : "In Memory of: ") + 
                           tributeFirstName + " " + tributeLastName;
          if (tributeMessage) {
            displayText += "<br><em>\"" + tributeMessage + "\"</em>";
          }
          
          tributeDisplay.innerHTML = displayText;
          tributeSummary.style.display = "block";
        } else {
          tributeSummary.style.display = "none";
        }
      } else {
        tributeSummary.style.display = "none";
      }
    }

    function computeTotals() {
      var amt = customActive ? parseFloat(customInput.value || "0") : Number(selectedAmount || 0);
      var cover = coverFee.checked;
      
      // Always calculate fee for display purposes
      var fee = 0;
      if (paymentMethod === "ach") {
        fee = Math.min(amt * 0.008, 5.0);
      } else if (paymentMethod === "card") {
        // Different rates based on card type
        if (cardType === "amex") {
          fee = amt * 0.035 + 0.30; // American Express: 3.5% + $0.30
        } else {
          fee = amt * 0.022 + 0.30; // Visa, Mastercard, Other: 2.2% + $0.30
        }
      } else {
        // wallet: 2.2% + $0.30 (PayPal, Apple Pay, Google Pay)
        fee = amt * 0.022 + 0.30;
      }
      
      // Only add fee to total if covering fees
      var total = cover ? amt + fee : amt;
      
      return { amt: amt, fee: fee, total: total };
    }

    function validateRequired() {
      var donationType = document.getElementById(prefix + "-donation-type").value;
      var email = document.getElementById(prefix + "-email").value.trim();
      var phone = document.getElementById(prefix + "-phone").value.trim();
      var manualWrap = document.getElementById(prefix + "-manual-address");
      var lookupInput = document.getElementById(prefix + "-address-lookup");
      var addr1 = document.getElementById(prefix + "-addr1");
      var city = document.getElementById(prefix + "-city");
      var stateSel = document.getElementById(prefix + "-state");
      var zip = document.getElementById(prefix + "-zip");
      var countrySel = document.getElementById(prefix + "-country");
      
      // Check if any manual address fields have values
      var hasManualAddressData = addr1.value.trim() || city.value.trim() || stateSel.value.trim() || zip.value.trim() || countrySel.value.trim();
      
      var addressOk = false;
      if (manualWrap.style.display !== "none" || hasManualAddressData) {
        // Manual address mode - check if all required fields are filled
        addressOk = addr1.value.trim() && city.value.trim() && stateSel.value.trim() && zip.value.trim() && countrySel.value.trim();
      } else {
        // Address lookup mode - check if lookup has at least 5 characters
        addressOk = lookupInput.value.trim().length >= 5;
      }
      
      var amountOk = customActive ? (parseFloat(customInput.value || "0") > 0) : (selectedAmount > 0);
      var category = document.getElementById(prefix + "-category").value;
      var otherOk = true;
      if (category.indexOf("Other") === 0) {
        otherOk = (document.getElementById(prefix + "-category-other").value.trim().length > 0);
      }
      
      // Validate identity based on donation type
      var identityOk = false;
      if (donationType === "individual") {
        var fname = document.getElementById(prefix + "-firstname").value.trim();
        var lname = document.getElementById(prefix + "-lastname").value.trim();
        identityOk = fname && lname && /.+@.+\..+/.test(email) && phone;
      } else {
        var orgName = document.getElementById(prefix + "-organization-name").value.trim();
        identityOk = orgName && /.+@.+\..+/.test(email) && phone;
      }
      
      // Tribute validation
      var tributeOk = true;
      if (isTributeSelected) {
        var tributeFirstName = document.getElementById(prefix + "-tribute-firstname").value.trim();
        var tributeLastName = document.getElementById(prefix + "-tribute-lastname").value.trim();
        tributeOk = tributeFirstName.length > 0 && tributeLastName.length > 0;
      }

      return identityOk && addressOk && amountOk && otherOk && tributeOk;
    }

    function updateTotals() {
      var t = computeTotals();
      var currentAmount = customActive ? (parseFloat(customInput.value || "0")) : selectedAmount;
      
      var freq = freqSel.value;
      var freqMap = { onetime: "", week: " every week", biweek: " every two weeks", month: " every month", year: " every year" };
      var freqText = freqMap[freq] || "";
      
      // Update the total preview on step 1
      if (totalPreview) {
        totalPreview.textContent = format(t.total) + freqText;
      }
      
      // Update step 3 summary elements if they exist
      if (giftEl) giftEl.textContent = format(currentAmount);
      if (feeEl) feeEl.textContent = format(t.fee); // Always show the actual fee amount
      if (feeLabel) feeLabel.textContent = document.getElementById(prefix + "-cover-fee").checked ? "" : "(covered by Refuge International)";
      
      // No need for custom interval logic since we're using fixed options now
      
      if (currentAmount > 0) {
        if (submitBtn) submitBtn.textContent = "Donate " + format(t.total) + freqText;
      } else {
        if (submitBtn) submitBtn.textContent = "Select an amount";
      }
      
      if (submitBtn) submitBtn.disabled = !validateRequired();

      // Update tribute display
      updateTributeDisplay();

      // Remove the separate recurring note since it's now in the button
      if (recurNote) recurNote.textContent = "";
    }

    function clearFieldErrors() {
      // Clear all error messages when users are actively fixing issues
      var errorIds = [
        prefix + "-amount-error",
        prefix + "-firstname-error",
        prefix + "-lastname-error", 
        prefix + "-organization-name-error",
        prefix + "-email-error",
        prefix + "-phone-error",
        prefix + "-address-lookup-error",
        prefix + "-addr1-error",
        prefix + "-city-error", 
        prefix + "-state-error",
        prefix + "-zip-error",
        prefix + "-country-error",
        prefix + "-tribute-firstname-error",
        prefix + "-tribute-lastname-error"
      ];
      
      errorIds.forEach(function(errorId) {
        var errorEl = document.getElementById(errorId);
        if (errorEl) {
          errorEl.style.display = "none";
        }
      });
    }
    
    // Category other reveal initial state
    catSel.dispatchEvent(new Event("change"));

    // Recalc handlers
    ["input","change"].forEach(function (ev) {
      document.getElementById(prefix + "-firstname").addEventListener(ev, function() {
        var fnameError = document.getElementById(prefix + "-firstname-error");
        if (fnameError) fnameError.style.display = "none";
        updateTotals();
      });
      document.getElementById(prefix + "-lastname").addEventListener(ev, function() {
        var lnameError = document.getElementById(prefix + "-lastname-error");
        if (lnameError) lnameError.style.display = "none";
        updateTotals();
      });
      // Organization name field event listener
      var orgNameInput = document.getElementById(prefix + "-organization-name");
      if (orgNameInput) {
        orgNameInput.addEventListener(ev, function() {
          var orgNameError = document.getElementById(prefix + "-organization-name-error");
          if (orgNameError) orgNameError.style.display = "none";
          updateTotals();
        });
      }
      document.getElementById(prefix + "-email").addEventListener(ev, function() {
        var emailError = document.getElementById(prefix + "-email-error");
        if (emailError) emailError.style.display = "none";
        updateTotals();
      });
      document.getElementById(prefix + "-phone").addEventListener(ev, function() {
        var phoneError = document.getElementById(prefix + "-phone-error");
        if (phoneError) phoneError.style.display = "none";
        updateTotals();
      });
      customInput.addEventListener(ev, function() {
        var amountError = document.getElementById(prefix + "-amount-error");
        if (amountError) amountError.style.display = "none";
        updateTotals();
      });
      freqSel.addEventListener(ev, updateTotals);
      catSel.addEventListener(ev, updateTotals);
      if (catOtherInput) {
        catOtherInput.addEventListener(ev, function() {
          var categoryError = document.getElementById(prefix + "-category-error");
          if (categoryError) {
            categoryError.style.display = "none";
          }
          updateTotals();
        });
      }
      coverFee.addEventListener(ev, updateTotals);
      addr1.addEventListener(ev, function() {
        var addr1Error = document.getElementById(prefix + "-addr1-error");
        if (addr1Error) addr1Error.style.display = "none";
        updateTotals();
      });
      addr2.addEventListener(ev, updateTotals);
      city.addEventListener(ev, function() {
        var cityError = document.getElementById(prefix + "-city-error");
        if (cityError) cityError.style.display = "none";
        updateTotals();
      });
      stateSel.addEventListener(ev, function() {
        var stateError = document.getElementById(prefix + "-state-error");
        if (stateError) stateError.style.display = "none";
        updateTotals();
      });
      zip.addEventListener(ev, function() {
        var zipError = document.getElementById(prefix + "-zip-error");
        if (zipError) zipError.style.display = "none";
        updateTotals();
      });
      countrySel.addEventListener(ev, function() {
        var countryError = document.getElementById(prefix + "-country-error");
        if (countryError) countryError.style.display = "none";
        updateTotals();
      });
      lookupInput.addEventListener(ev, function() {
        var lookupError = document.getElementById(prefix + "-address-lookup-error");
        if (lookupError) lookupError.style.display = "none";
        updateTotals();
      });
      
      // Tribute field event listeners
      var tributeFirstNameInput = document.getElementById(prefix + "-tribute-firstname");
      var tributeLastNameInput = document.getElementById(prefix + "-tribute-lastname");
      var tributeMessageInput = document.getElementById(prefix + "-tribute-message");
      
      if (tributeFirstNameInput) {
        tributeFirstNameInput.addEventListener(ev, function() {
          var tributeFirstNameError = document.getElementById(prefix + "-tribute-firstname-error");
          if (tributeFirstNameError) tributeFirstNameError.style.display = "none";
          updateTotals();
        });
      }
      
      if (tributeLastNameInput) {
        tributeLastNameInput.addEventListener(ev, function() {
          var tributeLastNameError = document.getElementById(prefix + "-tribute-lastname-error");
          if (tributeLastNameError) tributeLastNameError.style.display = "none";
          updateTotals();
        });
      }
      
      if (tributeMessageInput) {
        tributeMessageInput.addEventListener(ev, updateTotals);
      }
    });

    // Submit
    submitBtn.addEventListener("click", function () {
      if (!validateRequired()) return;

      var donationType = document.getElementById(prefix + "-donation-type").value;
      var email = document.getElementById(prefix + "-email").value.trim();
      var phone = document.getElementById(prefix + "-phone").value.trim();
      var freq = freqSel.value;
      var category = catSel.value;
      // If "Other (specify)" is selected, replace it with the custom text
      if (category === "Other (specify)") {
        var categoryOther = document.getElementById(prefix + "-category-other").value.trim();
        category = categoryOther || "Other";
      }

      var totals = computeTotals();
      var baseAmount = customActive ? parseFloat(customInput.value || "0") : selectedAmount;

      var payload = {
        donationType: donationType,
        livemode: category.toLowerCase() === "testing" ? false : true,
        email: email,
        phone: phone,
        address: {
          line1: addr1.value,
          line2: addr2.value,
          city: city.value,
          state: (stateSel.value || "").split(" - ")[0],
          postal_code: zip.value,
          country: countrySel.value
        },
        amount: Math.round(totals.total * 100),
        coverFee: coverFee.checked,
        paymentMethod: paymentMethod,
        frequency: freq,
        category: category,
        metadata: {
          campaign: category,
          campaign__c: category
        }
      };
      
      // Add individual or organization specific fields
      if (donationType === "individual") {
        var first = document.getElementById(prefix + "-firstname").value.trim();
        var last = document.getElementById(prefix + "-lastname").value.trim();
        payload.firstname = first;
        payload.lastname = last;
      } else {
        var orgName = document.getElementById(prefix + "-organization-name").value.trim();
        payload.organizationName = orgName;
        payload.lastname = orgName;
      }
      
      // Add tribute information if applicable
      if (isTributeSelected) {
        var tributeType = document.getElementById(prefix + "-tribute-type").value;
        var tributeFirstName = document.getElementById(prefix + "-tribute-firstname").value.trim();
        var tributeLastName = document.getElementById(prefix + "-tribute-lastname").value.trim();
        var tributeMessage = document.getElementById(prefix + "-tribute-message").value.trim();
        
        payload.tribute = {
          type: tributeType,
          firstName: tributeFirstName,
          lastName: tributeLastName,
          message: tributeMessage
        };
      }

      // Store original button text and show transfer message
      var originalButtonText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = "Transferring to Stripe...";

      console.log("Sending donation payload:", JSON.stringify(payload, null, 2));
      
      fetch(processDonationAPI, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
      .then(function (r) { 
        console.log("API Response status:", r.status);
        return r.json(); 
      })
      .then(function (session) {
        console.log("API Response data:", session);
        
        if (!session || !session.id) {
          throw new Error("Invalid session response: missing session ID. Response: " + JSON.stringify(session));
        }

        if (typeof session.url === "string" && session.url.trim().length > 0) {
          window.location.href = session.url;
          return;
        }

        var useLiveKey = typeof session.livemode === "boolean" ? session.livemode : payload.livemode;
        if (typeof session.id === "string") {
          if (session.id.startsWith("cs_test_")) {
            useLiveKey = false;
          } else if (session.id.startsWith("cs_live_")) {
            useLiveKey = true;
          }
        }

        var key = useLiveKey ? "pk_live_fJSacHhPB2h0mJfsFowRm8lQ" : "pk_test_y47nraQZ5IFgnTMlwbDvfj8D";
        var stripe = window.Stripe ? window.Stripe(key) : null;
        if (!stripe) { console.error("Stripe.js not loaded"); return; }
        return stripe.redirectToCheckout({ sessionId: session.id });
      })
      .catch(function (err) {
        console.error("Checkout error:", err);
        // Restore original button state only on error
        submitBtn.textContent = originalButtonText;
        submitBtn.disabled = false;
      });
    });

    // Initial totals
    updateTotals();
    
    // Set category from URL parameters if available
    if (params) {
      setCategoryFromParams(params);
    }
  }

  window.openDonationModal = function () {
    var modal = document.getElementById("dp-modal");
    if (modal) modal.style.display = "flex";
  };
  window.closeDonationModal = function () {
    var modal = document.getElementById("dp-modal");
    if (modal) modal.style.display = "none";
  };

  document.addEventListener("DOMContentLoaded", function () {
    mountPopup();     // attaches to #donation-popup (if present)
    mountEmbedded();  // attaches to #donation-form-embedded (if present)
  });
})();