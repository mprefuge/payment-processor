function getDonationFormRuntimeSource() {
  return String.raw`(function (global) {
  var US_STATES = [
    '',
    'AL - Alabama',
    'AK - Alaska',
    'AZ - Arizona',
    'AR - Arkansas',
    'CA - California',
    'CO - Colorado',
    'CT - Connecticut',
    'DE - Delaware',
    'FL - Florida',
    'GA - Georgia',
    'HI - Hawaii',
    'ID - Idaho',
    'IL - Illinois',
    'IN - Indiana',
    'IA - Iowa',
    'KS - Kansas',
    'KY - Kentucky',
    'LA - Louisiana',
    'ME - Maine',
    'MD - Maryland',
    'MA - Massachusetts',
    'MI - Michigan',
    'MN - Minnesota',
    'MS - Mississippi',
    'MO - Missouri',
    'MT - Montana',
    'NE - Nebraska',
    'NV - Nevada',
    'NH - New Hampshire',
    'NJ - New Jersey',
    'NM - New Mexico',
    'NY - New York',
    'NC - North Carolina',
    'ND - North Dakota',
    'OH - Ohio',
    'OK - Oklahoma',
    'OR - Oregon',
    'PA - Pennsylvania',
    'RI - Rhode Island',
    'SC - South Carolina',
    'SD - South Dakota',
    'TN - Tennessee',
    'TX - Texas',
    'UT - Utah',
    'VT - Vermont',
    'VA - Virginia',
    'WA - Washington',
    'WV - West Virginia',
    'WI - Wisconsin',
    'WY - Wyoming',
    'Outside US'
  ];

  var COUNTRIES = [
    '',
    'United States',
    'Canada',
    'Mexico',
    'United Kingdom',
    'Australia',
    'India',
    'Germany',
    'France',
    'Italy',
    'Spain',
    'South Africa',
    'Brazil',
    'Japan',
    'South Korea',
    'Not Listed'
  ];

  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(value) {
    var amount = Number(value || 0);
    return '$' + amount.toFixed(2);
  }

  function ensureArray(value, fallback) {
    return Array.isArray(value) && value.length ? value : fallback;
  }

  function ensureRuntimeStyle() {
    if (document.getElementById('df-runtime-style')) {
      return;
    }

    var style = document.createElement('style');
    style.id = 'df-runtime-style';
    style.textContent =
      '.df-host *{box-sizing:border-box}' +
      '.df-host{font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#1f1f1f}' +
      '.df-panel{background:#fff;border-radius:24px;box-shadow:0 10px 40px rgba(0,0,0,.15);overflow:visible}' +
      '.df-header{padding:12px 16px;border-bottom:4px solid var(--df-accent);display:flex;gap:14px;align-items:center;justify-content:center;background:#fff;border-radius:24px 24px 0 0}' +
      '.df-logo{width:56px;height:56px;object-fit:contain}' +
      '.df-title{margin:0;font-size:24px;line-height:1.1;text-align:center}' +
      '.df-description{margin:6px 0 0;color:#555;font-size:13px;text-align:center}' +
      '.df-body{padding:16px;max-width:700px;margin:0 auto;position:relative;overflow:visible}' +
      '.df-card{background:#fff;border-radius:18px;box-shadow:0 6px 24px rgba(189,33,53,.10),0 1px 6px rgba(0,0,0,.08);padding:24px;margin-bottom:16px;max-width:700px;margin-left:auto;margin-right:auto;overflow:visible}' +
      '.df-card h3{margin:0 0 16px;font-size:18px;font-weight:700;text-align:center}' +
      '.df-step-indicators{display:flex;justify-content:center;margin-bottom:20px}' +
      '.df-dot{display:flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;background:#ccc;position:relative;margin:0 8px}' +
      '.df-dot.is-active{background:var(--df-accent)}' +
      '.df-dot.is-complete{background:#000}' +
      '.df-dot:after{content:\'\';position:absolute;top:50%;left:100%;width:40px;height:2px;background:#ccc;transform:translateY(-50%);z-index:0}' +
      '.df-dot:last-child:after{display:none}' +
      '.df-dot.is-complete:after{background:#000}' +
      '.df-dot.is-active:after{background:var(--df-accent)}' +
      '.df-grid{display:grid;gap:10px}' +
      '.df-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}' +
      '.df-grid-4{grid-template-columns:repeat(4,minmax(0,1fr))}' +
      '.df-label{display:block;font-size:14px;font-weight:600;color:#222;margin-bottom:6px}' +
      '.df-input,.df-select,.df-textarea{width:100%;padding:12px;border:1.5px solid #e0e0e0;border-radius:10px;background:#fafbfc;font-size:16px;outline:none;transition:.2s border-color,.2s box-shadow,.2s background;font:inherit}' +
      '.df-textarea{min-height:86px;resize:vertical}' +
      '.df-address-lookup-wrap{position:relative}' +
      '.df-address-manual-link{font-size:14px;font-weight:700;color:var(--df-accent);cursor:pointer;white-space:nowrap}' +
      '.df-address-suggestions{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #ddd;border-radius:0 0 10px 10px;box-shadow:0 8px 20px rgba(0,0,0,.08);max-height:220px;overflow:auto;display:none;z-index:10001}' +
      '.df-address-item{padding:9px 10px;cursor:pointer;font-size:13px;line-height:1.35}' +
      '.df-address-item:hover{background:#f7f7f7}' +
      '.df-input:focus,.df-select:focus,.df-textarea:focus{border-color:var(--df-accent);box-shadow:0 0 0 2px rgba(189,33,53,.2);background:#fff}' +
      '.df-row{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}' +
      '.df-amount-row{flex-wrap:nowrap;margin-bottom:8px}' +
      '.df-amount-row:last-child{margin-bottom:0}' +
      '.df-chip{padding:12px 18px;border-radius:999px;border:1.5px solid #d4d4d4;background:#fff;font-weight:700;cursor:pointer;transition:.2s;font-size:16px}' +
      '.df-chip:hover{border-color:var(--df-accent);color:var(--df-accent)}' +
      '.df-chip.is-selected{background:var(--df-accent);border-color:var(--df-accent);color:#fff;box-shadow:0 2px 10px rgba(189,33,53,.25)}' +
      '.df-chip.is-amount{border-radius:8px;min-width:90px;padding:14px 18px;font-size:18px;font-weight:800;text-align:center;white-space:nowrap}' +
      '.df-chip.is-amount:hover,.df-chip.is-amount.is-selected{transform:translateY(-1px);box-shadow:0 4px 12px rgba(189,33,53,.22)}' +
      '.df-frequency-chip,.df-tribute-chip,.df-donation-type-chip{border-radius:8px;min-width:120px}' +
      '.df-inline{display:flex;align-items:center;gap:8px}' +
      '.df-inline input{width:16px;height:16px}' +
      '.df-nav{display:flex;justify-content:space-between;gap:10px;margin-top:20px}' +
      '.df-btn{padding:12px 24px;border-radius:8px;border:2px solid var(--df-accent);font:inherit;font-weight:600;cursor:pointer;transition:.3s all ease}' +
      '.df-btn.primary{background:var(--df-accent);color:#fff}' +
      '.df-btn.ghost{background:#fff;color:var(--df-accent)}' +
      '.df-btn:hover{opacity:.95;transform:translateY(-1px);box-shadow:0 4px 12px rgba(189,33,53,.25)}' +
      '.df-btn[disabled]{opacity:.55;cursor:not-allowed}' +
      '.df-total{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;background:#f8f9fa;border:2px solid transparent;border-radius:12px;padding:16px}' +
      '.df-total-money{font-size:24px;font-weight:700;color:var(--df-accent)}' +
      '.df-submit{width:100%;padding:16px;border-radius:12px;border:0;background:var(--df-accent);color:#fff;font-size:20px;font-weight:800;cursor:pointer;box-shadow:0 6px 20px rgba(189,33,53,.18);transition:.2s}' +
      '.df-submit:hover{background:#a81c2d}' +
      '.df-submit[disabled]{opacity:.6;cursor:not-allowed;box-shadow:none}' +
      '.df-meta{margin-top:8px;font-size:12px;color:#666;text-align:center}' +
      '.df-error{margin-top:8px;color:var(--df-accent);font-weight:700;display:none}' +
      '.df-preview-result{margin-top:10px;padding:10px;border-radius:10px;background:#f7f7f7;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap;display:none}' +
      '.df-modal-open{padding:12px 18px;border-radius:999px;border:0;background:var(--df-accent);color:#fff;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 14px 30px rgba(189,33,53,.25)}' +
      '.df-modal{position:fixed;inset:0;background:rgba(0,0,0,.52);display:none;align-items:center;justify-content:center;z-index:9999;padding:12px}' +
      '.df-modal.is-open{display:flex}' +
      '.df-modal-wrap{width:min(760px,100%);max-height:92vh;overflow:auto}' +
      '.df-close{position:absolute;top:10px;right:10px;background:#fff;border:0;width:34px;height:34px;border-radius:50%;font-size:20px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.2)}' +
      '.df-embedded .df-panel{border-radius:20px}.df-embedded .df-header{border-radius:20px 20px 0 0}' +
      '@media (max-width: 760px){.df-grid-2,.df-grid-4{grid-template-columns:1fr}.df-title{font-size:21px}.df-total-money{font-size:21px}.df-panel{border-radius:12px}.df-header{border-radius:12px 12px 0 0}.df-card{padding:18px}.df-amount-row{flex-wrap:wrap;justify-content:center}}';
    document.head.appendChild(style);
  }

  function normalizeConfig(rawConfig) {
    var config = rawConfig && typeof rawConfig === 'object' ? clone(rawConfig) : {};
    config.branding = config.branding || {};
    config.display = config.display || {};
    config.endpoints = config.endpoints || {};
    config.options = config.options || {};
    config.payment = config.payment || {};
    config.sections = ensureArray(config.sections, []);
    config.pages = ensureArray(config.pages, []);
    config.stripe = config.stripe || {};

    config.branding.organizationName = config.branding.organizationName || 'Organization';
    config.branding.title = config.branding.title || 'Donation Form';
    config.branding.description = config.branding.description || '';
    config.branding.logoUrl = config.branding.logoUrl || '';
    config.branding.accentColor = config.branding.accentColor || '#BD2135';
    config.branding.submitLabel = config.branding.submitLabel || 'Donate now';

    var mode = String(config.display.mode || 'embedded').toLowerCase();
    config.display.mode = mode === 'modal' ? 'modal' : 'embedded';
    config.display.modalTriggerLabel = config.display.modalTriggerLabel || 'Open donation form';

    config.endpoints.processDonationApi = config.endpoints.processDonationApi || '/api/transaction';

    config.payment.defaultFrequency = config.payment.defaultFrequency || 'onetime';
    config.payment.amountPresets = ensureArray(config.payment.amountPresets, [100, 50, 25, 10]);
    config.payment.categories = ensureArray(config.payment.categories, ['General Giving']);

    config.options.allowRecurring = config.options.allowRecurring !== false;
    config.options.allowOrganizationGiving = config.options.allowOrganizationGiving !== false;
    config.options.collectAddress = config.options.collectAddress !== false;
    config.options.enableTribute = config.options.enableTribute !== false;
    config.options.enableFeeCoverage = config.options.enableFeeCoverage !== false;
    config.pages = ensurePages(config);

    return config;
  }

  function getSection(config, id) {
    return config.sections.find(function (entry) {
      return entry && entry.id === id;
    }) || null;
  }

  function getSectionType(section) {
    return section && (section.type || section.id) ? String(section.type || section.id).toLowerCase() : '';
  }

  function sectionEnabled(config, idOrSection) {
    var section = typeof idOrSection === 'string' ? getSection(config, idOrSection) : idOrSection;

    return !section || section.enabled !== false;
  }

  function sectionVisible(config, section) {
    if (!sectionEnabled(config, section)) {
      return false;
    }

    var type = getSectionType(section);
    if (type === 'address') {
      return config.options.collectAddress;
    }
    if (type === 'tribute') {
      return config.options.enableTribute;
    }
    if (type === 'fees') {
      return config.options.enableFeeCoverage;
    }

    return true;
  }

  function deriveDefaultPages(config) {
    var pages = [
      { id: 'page_donation', name: 'Donation', description: 'Choose an amount and designation.', sectionIds: [] },
      { id: 'page_donor', name: 'Donor Details', description: 'Collect donor details and address.', sectionIds: [] },
      { id: 'page_review', name: 'Review & Submit', description: 'Confirm and continue to Stripe Checkout.', sectionIds: [] }
    ];

    config.sections.forEach(function (section) {
      var type = getSectionType(section);
      if (type === 'hero' || type === 'amount') {
        pages[0].sectionIds.push(section.id);
      } else if (type === 'donor' || type === 'address' || type === 'tribute' || type === 'content') {
        pages[1].sectionIds.push(section.id);
      } else {
        pages[2].sectionIds.push(section.id);
      }
    });

    return pages.filter(function (page) {
      return page.sectionIds.length;
    });
  }

  function ensurePages(config) {
    var validSectionIds = {};
    config.sections.forEach(function (section) {
      validSectionIds[section.id] = true;
    });

    var pages = ensureArray(config.pages, []).map(function (page, index) {
      var sectionIds = ensureArray(page && page.sectionIds, []).filter(function (sectionId, sectionIndex, arr) {
        return validSectionIds[sectionId] && arr.indexOf(sectionId) === sectionIndex;
      });

      return {
        id: page && page.id ? String(page.id) : 'page_' + String(index + 1),
        name: page && page.name ? String(page.name) : 'Page ' + String(index + 1),
        description: page && page.description ? String(page.description) : '',
        sectionIds: sectionIds,
      };
    }).filter(function (page, index, arr) {
      return page.sectionIds.length && arr.findIndex(function (entry) { return entry.id === page.id; }) === index;
    });

    if (!pages.length) {
      pages = deriveDefaultPages(config);
    }

    if (!pages.length) {
      pages = [{ id: 'page_1', name: 'Page 1', description: '', sectionIds: [] }];
    }

    var assigned = {};
    pages.forEach(function (page) {
      page.sectionIds = page.sectionIds.filter(function (sectionId) {
        if (assigned[sectionId]) {
          return false;
        }
        assigned[sectionId] = true;
        return true;
      });
    });

    config.sections.forEach(function (section) {
      if (!assigned[section.id]) {
        pages[pages.length - 1].sectionIds.push(section.id);
      }
    });

    return pages;
  }

  function getRenderablePages(config) {
    return config.pages
      .map(function (page) {
        var sections = page.sectionIds
          .map(function (sectionId) { return getSection(config, sectionId); })
          .filter(function (section) { return section && sectionVisible(config, section); });

        return {
          id: page.id,
          name: page.name,
          description: page.description,
          sections: sections,
        };
      })
      .filter(function (page) {
        return page.sections.length;
      });
  }

  function feeFor(amount, paymentMethod, cardType) {
    var numericAmount = Number(amount || 0);
    if (!(numericAmount > 0)) {
      return 0;
    }
    if (paymentMethod === 'ach') {
      return Math.min(numericAmount * 0.008, 5);
    }
    if (paymentMethod === 'card') {
      return numericAmount * (cardType === 'amex' ? 0.035 : 0.022) + 0.3;
    }
    return numericAmount * 0.022 + 0.3;
  }

  function createState(config) {
    return {
      step: 1,
      amount: Number(config.payment.amountPresets[0] || 0),
      customAmount: '',
      useCustomAmount: false,
      addressMode: 'lookup',
      frequency: config.payment.defaultFrequency || 'onetime',
      category: config.payment.categories[0] || '',
      categoryOther: '',
      donationType: 'individual',
      coverFee: false,
      paymentMethod: 'card',
      cardType: 'visa',
      tributeEnabled: false,
      tributeType: 'honor',
      fields: {
        firstName: '',
        lastName: '',
        organization: '',
        email: '',
        phone: '',
        addressLookup: '',
        address1: '',
        address2: '',
        city: '',
        state: '',
        postalCode: '',
        country: 'United States',
        tributeFirstName: '',
        tributeLastName: '',
        tributeMessage: '',
      },
    };
  }

  function currentAmount(state) {
    return state.useCustomAmount ? Number(state.customAmount || 0) : Number(state.amount || 0);
  }

  function frequencyLabel(value) {
    var map = {
      onetime: '',
      week: ' every week',
      biweek: ' every two weeks',
      month: ' every month',
      year: ' every year',
    };
    return map[value] || '';
  }

  function totals(state) {
    var amount = currentAmount(state);
    var fee = feeFor(amount, state.paymentMethod, state.cardType);
    return {
      amount: amount,
      fee: fee,
      total: state.coverFee ? amount + fee : amount,
    };
  }

  function validatePage(config, state, pageNumber) {
    var pages = getRenderablePages(config);
    var page = pages[pageNumber - 1];
    if (!page) {
      return { ok: true, message: '' };
    }

    var pageTypes = page.sections.map(function (section) {
      return getSectionType(section);
    });

    if (pageTypes.indexOf('amount') >= 0) {
      var amount = currentAmount(state);
      if (!(amount > 0)) {
        return { ok: false, message: 'Please choose or enter an amount.' };
      }
      if (!state.category) {
        return { ok: false, message: 'Please choose a category.' };
      }
      if (state.category.indexOf('Other') === 0 && !state.categoryOther.trim()) {
        return { ok: false, message: 'Please describe the donation category.' };
      }
      return { ok: true, message: '' };
    }

    if (
      pageTypes.indexOf('donor') >= 0 ||
      pageTypes.indexOf('address') >= 0 ||
      pageTypes.indexOf('tribute') >= 0
    ) {
      if (state.donationType === 'individual') {
        if (!state.fields.firstName.trim() || !state.fields.lastName.trim()) {
          return { ok: false, message: 'Please enter first and last name.' };
        }
      } else if (!state.fields.organization.trim()) {
        return { ok: false, message: 'Please enter organization name.' };
      }

      if (!/.+@.+\..+/.test(state.fields.email.trim())) {
        return { ok: false, message: 'Please enter a valid email address.' };
      }
      if (!state.fields.phone.trim()) {
        return { ok: false, message: 'Please enter a phone number.' };
      }

      if (pageTypes.indexOf('address') >= 0 && sectionEnabled(config, 'address') && config.options.collectAddress) {
        var usingLookup = state.addressMode === 'lookup';
        if (usingLookup) {
          if (!state.fields.addressLookup || state.fields.addressLookup.trim().length < 5) {
            return { ok: false, message: 'Please include your address.' };
          }
        } else {
          if (
            !state.fields.address1.trim() ||
            !state.fields.city.trim() ||
            !state.fields.state.trim() ||
            !state.fields.postalCode.trim() ||
            !state.fields.country.trim()
          ) {
            return { ok: false, message: 'Please complete the address.' };
          }
        }
      }

      if (pageTypes.indexOf('tribute') >= 0 && sectionEnabled(config, 'tribute') && config.options.enableTribute && state.tributeEnabled) {
        if (!state.fields.tributeFirstName.trim() || !state.fields.tributeLastName.trim()) {
          return { ok: false, message: 'Please complete tribute name fields.' };
        }
      }

      return { ok: true, message: '' };
    }

    return { ok: true, message: '' };
  }

  function buildPayload(config, state) {
    var computedTotals = totals(state);
    var category = state.category.indexOf('Other') === 0 ? state.categoryOther.trim() : state.category;

    var payload = {
      donationType: state.donationType,
      livemode: category.toLowerCase() === 'test' ? false : true,
      email: state.fields.email.trim(),
      phone: state.fields.phone.trim(),
      address: {
        line1: state.fields.address1.trim(),
        line2: state.fields.address2.trim(),
        city: state.fields.city.trim(),
        state: state.fields.state.trim(),
        postal_code: state.fields.postalCode.trim(),
        country: state.fields.country.trim(),
      },
      amount: Math.round(computedTotals.total * 100),
      coverFee: state.coverFee,
      paymentMethod: state.paymentMethod,
      frequency: state.frequency,
      category: category,
    };

    if (state.donationType === 'individual') {
      payload.firstname = state.fields.firstName.trim();
      payload.lastname = state.fields.lastName.trim();
    } else {
      payload.organization = state.fields.organization.trim();
      payload.firstname = state.fields.organization.trim();
    }

    if (sectionEnabled(config, 'tribute') && config.options.enableTribute && state.tributeEnabled) {
      payload.tribute = {
        type: state.tributeType,
        firstName: state.fields.tributeFirstName.trim(),
        lastName: state.fields.tributeLastName.trim(),
        message: state.fields.tributeMessage.trim(),
      };
    }

    return payload;
  }

  function ensureStripeLoaded() {
    if (global.Stripe) {
      return Promise.resolve(global.Stripe);
    }

    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-stripe-js]');
      if (existing) {
        var checkCount = 0;
        var timer = setInterval(function () {
          checkCount += 1;
          if (global.Stripe) {
            clearInterval(timer);
            resolve(global.Stripe);
          } else if (checkCount > 60) {
            clearInterval(timer);
            reject(new Error('Stripe.js failed to load.'));
          }
        }, 100);
        return;
      }

      var script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      script.setAttribute('data-stripe-js', 'true');
      script.onload = function () {
        resolve(global.Stripe);
      };
      script.onerror = function () {
        reject(new Error('Stripe.js failed to load.'));
      };
      document.head.appendChild(script);
    });
  }

  function createWizardMarkup(config, state, options) {
    var amountButtons = config.payment.amountPresets
      .map(function (amount) {
        return '<button type="button" class="df-chip df-amount df-amount-chip is-amount" data-amount="' + escapeHtml(amount) + '">' + formatMoney(amount) + '</button>';
      })
      .join('');

    var frequencyButtons = config.options.allowRecurring
      ? '<div class="df-row" data-frequency-row>' +
          '<button type="button" class="df-chip df-frequency df-frequency-chip" data-frequency="onetime">One-Time</button>' +
          '<button type="button" class="df-chip df-frequency df-frequency-chip" data-frequency="month">Monthly</button>' +
          '<button type="button" class="df-chip df-frequency df-frequency-chip" data-frequency="biweek">Bi-Weekly</button>' +
          '<button type="button" class="df-chip df-frequency df-frequency-chip" data-frequency="year">Yearly</button>' +
        '</div>'
      : '';

    var categoryOptions = config.payment.categories
      .map(function (category) {
        return '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>';
      })
      .join('');

    var stateOptions = US_STATES.map(function (stateValue) {
      return '<option value="' + escapeHtml(stateValue) + '">' + escapeHtml(stateValue) + '</option>';
    }).join('');

    var countryOptions = COUNTRIES.map(function (countryValue) {
      return '<option value="' + escapeHtml(countryValue) + '">' + escapeHtml(countryValue) + '</option>';
    }).join('');

    function renderSection(section) {
      var type = getSectionType(section);
      var heading = section.label ? escapeHtml(section.label) : '';
      var description = section.description ? '<p class="df-section-copy">' + escapeHtml(section.description) + '</p>' : '';

      if (type === 'hero') {
        return '';
      }

      if (type === 'content') {
        var body = section.settings && section.settings.body
          ? '<div class="df-content-body">' + escapeHtml(section.settings.body).replace(/\n/g, '<br>') + '</div>'
          : '';
        return '<div class="df-card df-card-content"><h3>' + heading + '</h3>' + description + body + '</div>';
      }

      if (type === 'amount') {
        return '' +
          '<div class="df-card"><h3>' + (heading || 'Donation Details') + '</h3>' + description +
            frequencyButtons +
            '<div class="df-row df-amount-row" style="margin-top:10px" data-amount-row>' +
              amountButtons +
              '<button type="button" class="df-chip df-amount df-amount-chip is-amount" data-amount="custom">Other</button>' +
            '</div>' +
            '<div class="df-grid" data-custom-wrap style="display:none;margin-top:10px"><div><label class="df-label">Custom amount</label><input type="number" min="1" step="0.01" class="df-input" data-field="customAmount"></div></div>' +
            '<div class="df-grid" style="margin-top:10px"><div><label class="df-label">Category</label><select class="df-select" data-field="category">' + categoryOptions + '</select></div></div>' +
            '<div class="df-grid" data-other-wrap style="display:none;margin-top:10px"><div><label class="df-label">Other category</label><input class="df-input" data-field="categoryOther"></div></div>' +
          '</div>';
      }

      if (type === 'donor') {
        return '' +
          '<div class="df-card"><h3>' + (heading || 'Your Information') + '</h3>' + description +
            (config.options.allowOrganizationGiving
              ? '<div class="df-row" data-donor-row><button type="button" class="df-chip df-donor df-donation-type-chip" data-donation-type="individual">Individual</button><button type="button" class="df-chip df-donor df-donation-type-chip" data-donation-type="organization">Organization</button></div>'
              : '') +
            '<div class="df-grid df-grid-2" style="margin-top:10px" data-individual-fields><div><label class="df-label">First name</label><input class="df-input" data-field="firstName"></div><div><label class="df-label">Last name</label><input class="df-input" data-field="lastName"></div></div>' +
            '<div class="df-grid" style="margin-top:10px;display:none" data-organization-fields><div><label class="df-label">Organization</label><input class="df-input" data-field="organization"></div></div>' +
            '<div class="df-grid df-grid-2" style="margin-top:10px"><div><label class="df-label">Email</label><input class="df-input" type="email" data-field="email"></div><div><label class="df-label">Phone</label><input class="df-input" data-field="phone"></div></div>' +
          '</div>';
      }

      if (type === 'address') {
        return '' +
          '<div class="df-card"><h3>' + (heading || 'Address') + '</h3>' + description +
            '<div data-address-lookup-row style="margin-top:10px"><div class="df-address-lookup-wrap"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px"><label class="df-label" style="margin:0">Address</label><span class="df-address-manual-link" data-enter-manual>Enter manually</span></div><input class="df-input" data-field="addressLookup" autocomplete="off" placeholder="Start typing your address"><div class="df-address-suggestions" data-address-suggestions></div></div></div>' +
            '<div data-manual-address style="display:none;margin-top:10px"><div class="df-grid df-grid-2"><div><label class="df-label">Address line 1</label><input class="df-input" data-field="address1"></div><div><label class="df-label">Address line 2</label><input class="df-input" data-field="address2"></div></div>' +
            '<div class="df-grid df-grid-4" style="margin-top:10px"><div><label class="df-label">City</label><input class="df-input" data-field="city"></div><div><label class="df-label">State</label><select class="df-select" data-field="state">' + stateOptions + '</select></div><div><label class="df-label">Postal code</label><input class="df-input" data-field="postalCode"></div><div><label class="df-label">Country</label><select class="df-select" data-field="country">' + countryOptions + '</select></div></div></div>' +
          '</div>';
      }

      if (type === 'tribute') {
        return '' +
          '<div class="df-card"><h3>' + (heading || 'Tribute') + '</h3>' + description +
            '<label class="df-inline"><input type="checkbox" data-field="tributeEnabled"> Tribute gift</label>' +
            '<div data-tribute-wrap style="display:none;margin-top:10px"><div class="df-row"><button type="button" class="df-chip df-tribute df-tribute-chip" data-tribute-type="honor">In Honor</button><button type="button" class="df-chip df-tribute df-tribute-chip" data-tribute-type="memory">In Memory</button></div>' +
            '<div class="df-grid df-grid-2" style="margin-top:10px"><div><label class="df-label">First name</label><input class="df-input" data-field="tributeFirstName"></div><div><label class="df-label">Last name</label><input class="df-input" data-field="tributeLastName"></div></div>' +
            '<div class="df-grid" style="margin-top:10px"><div><label class="df-label">Message</label><textarea class="df-textarea" data-field="tributeMessage"></textarea></div></div></div>' +
          '</div>';
      }

      if (type === 'fees') {
        return '' +
          '<div class="df-card"><h3>' + (heading || 'Processing Fees') + '</h3>' + description +
            '<label class="df-inline"><input type="checkbox" data-field="coverFee"> Cover processing fee</label>' +
            '<div data-payment-wrap style="display:none;margin-top:10px"><div class="df-row"><button type="button" class="df-chip df-payment" data-payment-method="card">Card</button><button type="button" class="df-chip df-payment" data-payment-method="ach">Bank</button><button type="button" class="df-chip df-payment" data-payment-method="wallet">Wallet</button></div>' +
            '<div data-card-wrap style="margin-top:8px"><div class="df-row"><button type="button" class="df-chip df-card" data-card-type="visa">Visa</button><button type="button" class="df-chip df-card" data-card-type="mastercard">Mastercard</button><button type="button" class="df-chip df-card" data-card-type="amex">AmEx</button><button type="button" class="df-chip df-card" data-card-type="other">Other</button></div></div></div>' +
          '</div>';
      }

      if (type === 'submit') {
        return '' +
          '<div class="df-card"><h3>' + (heading || 'Review & Submit') + '</h3>' + description +
            '<div class="df-total"><div><div class="df-label" style="margin:0 0 2px;text-transform:none;letter-spacing:0;font-size:13px">Total</div><div class="df-total-money" data-total-display>$0.00</div></div><div class="df-label" data-frequency-display style="margin:0;text-transform:none;letter-spacing:0"></div></div>' +
            '<div class="df-error" data-error></div>' +
            '<button type="button" class="df-submit" data-submit style="margin-top:10px"></button>' +
            '<div class="df-meta">After clicking donate, the donor will be redirected to Stripe Checkout.</div>' +
            (options.mode === 'preview' ? '<pre class="df-preview-result" data-preview-result></pre>' : '') +
          '</div>';
      }

      return '';
    }

    var pages = getRenderablePages(config);
    var showHeader = pages.some(function (page) {
      return page.sections.some(function (section) {
        return getSectionType(section) === 'hero';
      });
    });

    return '' +
      '<div class="df-panel" style="--df-accent:' + escapeHtml(config.branding.accentColor) + '">' +
        (showHeader
          ? '<div class="df-header">' +
              (config.branding.logoUrl ? '<img class="df-logo" src="' + escapeHtml(config.branding.logoUrl) + '" alt="logo">' : '') +
              '<div><h2 class="df-title">' + escapeHtml(config.branding.title) + '</h2><p class="df-description">' + escapeHtml(config.branding.description) + '</p></div>' +
            '</div>'
          : '') +
        '<div class="df-body">' +
          '<div class="df-step-indicators">' +
            pages.map(function (_page, index) {
              return '<span class="df-dot" data-dot="' + String(index + 1) + '"></span>';
            }).join('') +
          '</div>' +
          pages.map(function (page, index) {
            var isFirst = index === 0;
            var isLast = index === pages.length - 1;
            var nav = '<div class="df-nav">' +
              (isFirst ? '<span></span>' : '<button type="button" class="df-btn ghost" data-prev>Previous</button>') +
              (isLast ? '<span></span>' : '<button type="button" class="df-btn primary" data-next>Next</button>') +
            '</div>';

            return '<div class="df-step" data-step="' + String(index + 1) + '" style="display:' + (isFirst ? '' : 'none') + '">' +
              '<div class="df-step-meta"><div class="df-step-title">' + escapeHtml(page.name || ('Page ' + String(index + 1))) + '</div>' +
              (page.description ? '<div class="df-step-description">' + escapeHtml(page.description) + '</div>' : '') +
              '</div>' +
              page.sections.map(function (section) { return renderSection(section); }).join('') +
              nav +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  function renderWizard(host, config, options) {
    var state = createState(config);
    host.innerHTML = createWizardMarkup(config, state, options);

    var dots = host.querySelectorAll('[data-dot]');
    var steps = host.querySelectorAll('[data-step]');
    var lookupTimer = null;

    function selectButtons(selector, value, attr) {
      host.querySelectorAll(selector).forEach(function (button) {
        button.classList.toggle('is-selected', button.getAttribute(attr) === value);
      });
    }

    function syncDonorFields() {
      var individual = host.querySelector('[data-individual-fields]');
      var organization = host.querySelector('[data-organization-fields]');
      if (individual) {
        individual.style.display = state.donationType === 'individual' ? '' : 'none';
      }
      if (organization) {
        organization.style.display = state.donationType === 'organization' ? '' : 'none';
      }
    }

    function syncTribute() {
      var tributeWrap = host.querySelector('[data-tribute-wrap]');
      if (tributeWrap) {
        tributeWrap.style.display = state.tributeEnabled ? '' : 'none';
      }
    }

    function syncCategoryOther() {
      var otherWrap = host.querySelector('[data-other-wrap]');
      if (otherWrap) {
        otherWrap.style.display = state.category.indexOf('Other') === 0 ? '' : 'none';
      }
    }

    function syncCustomAmount() {
      var customWrap = host.querySelector('[data-custom-wrap]');
      var customInput = host.querySelector('[data-field="customAmount"]');
      if (!customWrap || !customInput) {
        return;
      }

      var visible = state.useCustomAmount;
      customWrap.style.display = visible ? '' : 'none';
      customInput.disabled = !visible;
      if (!visible) {
        customInput.value = '';
      }
    }

    function syncPayment() {
      var paymentWrap = host.querySelector('[data-payment-wrap]');
      var cardWrap = host.querySelector('[data-card-wrap]');
      if (paymentWrap) {
        paymentWrap.style.display = state.coverFee ? '' : 'none';
      }
      if (cardWrap) {
        cardWrap.style.display = state.coverFee && state.paymentMethod === 'card' ? '' : 'none';
      }
    }

    function syncAddressMode() {
      var lookupRow = host.querySelector('[data-address-lookup-row]');
      var manualWrap = host.querySelector('[data-manual-address]');
      if (!lookupRow || !manualWrap) {
        return;
      }

      if (state.addressMode === 'manual') {
        lookupRow.style.display = 'none';
        manualWrap.style.display = '';
      } else {
        lookupRow.style.display = '';
        manualWrap.style.display = 'none';
      }
    }

    function hideAddressSuggestions() {
      var suggestions = host.querySelector('[data-address-suggestions]');
      if (suggestions) {
        suggestions.style.display = 'none';
        suggestions.innerHTML = '';
      }
    }

    function assignAddressFromLookup(address) {
      if (!address) {
        return;
      }

      var line1 = ((address.house_number ? address.house_number + ' ' : '') + (address.road || address.pedestrian || address.footway || '')).trim();
      if (line1) {
        state.fields.address1 = line1;
      }
      state.fields.city = address.city || address.town || address.village || address.hamlet || state.fields.city;
      state.fields.postalCode = address.postcode || state.fields.postalCode;
      state.fields.country = address.country || state.fields.country || 'United States';

      if (address.state) {
        var matchedState = US_STATES.find(function (entry) {
          return entry.toLowerCase().indexOf(String(address.state).toLowerCase()) >= 0;
        });
        state.fields.state = matchedState || address.state;
      }

      var byField = {
        address1: host.querySelector('[data-field="address1"]'),
        city: host.querySelector('[data-field="city"]'),
        state: host.querySelector('[data-field="state"]'),
        postalCode: host.querySelector('[data-field="postalCode"]'),
        country: host.querySelector('[data-field="country"]'),
      };

      Object.keys(byField).forEach(function (key) {
        if (byField[key]) {
          byField[key].value = state.fields[key] || '';
        }
      });
    }

    function runAddressLookup(query) {
      var suggestions = host.querySelector('[data-address-suggestions]');
      if (!suggestions) {
        return;
      }

      if (!query || query.length < 5) {
        hideAddressSuggestions();
        return;
      }

      if (lookupTimer) {
        clearTimeout(lookupTimer);
      }

      lookupTimer = setTimeout(function () {
        fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(query) + '&format=json&addressdetails=1&limit=5&countrycodes=us')
          .then(function (response) {
            return response.json();
          })
          .then(function (items) {
            suggestions.innerHTML = '';
            if (!items || !items.length) {
              suggestions.style.display = 'none';
              return;
            }

            items.forEach(function (item) {
              var option = document.createElement('div');
              option.className = 'df-address-item';
              option.textContent = item.display_name;
              option.addEventListener('click', function () {
                state.fields.addressLookup = item.display_name;
                var lookupInput = host.querySelector('[data-field="addressLookup"]');
                if (lookupInput) {
                  lookupInput.value = item.display_name;
                }
                state.addressMode = 'manual';
                assignAddressFromLookup(item.address || {});
                hideAddressSuggestions();
                syncAddressMode();
                syncTotals();
              });
              suggestions.appendChild(option);
            });

            suggestions.style.display = 'block';
          })
          .catch(function () {
            hideAddressSuggestions();
          });
      }, 240);
    }

    function syncStep() {
      steps.forEach(function (stepEl, index) {
        stepEl.style.display = index + 1 === state.step ? '' : 'none';
      });
      dots.forEach(function (dotEl, index) {
        dotEl.classList.toggle('is-active', index + 1 === state.step);
        dotEl.classList.toggle('is-complete', index + 1 < state.step);
      });
    }

    function syncTotals() {
      var computed = totals(state);
      var totalDisplay = host.querySelector('[data-total-display]');
      var frequencyDisplay = host.querySelector('[data-frequency-display]');
      var submit = host.querySelector('[data-submit]');

      if (totalDisplay) {
        totalDisplay.textContent = formatMoney(computed.total);
      }
      if (frequencyDisplay) {
        frequencyDisplay.textContent = frequencyLabel(state.frequency);
      }
      if (submit) {
        submit.textContent =
          escapeHtml(config.branding.submitLabel) + ' ' + formatMoney(computed.total) + frequencyLabel(state.frequency);
      }

      var error = host.querySelector('[data-error]');
      if (error) {
        error.style.display = 'none';
      }
    }

    function handleInput(el) {
      var field = el.getAttribute('data-field');
      if (!field) {
        return;
      }

      if (field === 'customAmount') {
        state.customAmount = el.value;
        state.useCustomAmount = Boolean(el.value);
        if (state.useCustomAmount) {
          selectButtons('.df-amount', 'custom', 'data-amount');
        }
      } else if (field === 'category') {
        state.category = el.value;
      } else if (field === 'categoryOther') {
        state.categoryOther = el.value;
      } else if (field === 'coverFee') {
        state.coverFee = el.checked;
      } else if (field === 'tributeEnabled') {
        state.tributeEnabled = el.checked;
      } else if (field === 'addressLookup') {
        state.fields.addressLookup = el.value;
        runAddressLookup(state.fields.addressLookup.trim());
      } else if (state.fields.hasOwnProperty(field)) {
        state.fields[field] = el.value;
      }

      syncCategoryOther();
      syncCustomAmount();
      syncTribute();
      syncPayment();
      syncAddressMode();
      syncTotals();
    }

    function showError(message) {
      var error = host.querySelector('[data-error]');
      if (error) {
        error.textContent = message;
        error.style.display = 'block';
      }
    }

    host.addEventListener('click', function (event) {
      var amountBtn = event.target.closest('.df-amount');
      if (amountBtn) {
        var amountValue = amountBtn.getAttribute('data-amount');
        if (amountValue === 'custom') {
          state.useCustomAmount = true;
        } else {
          state.useCustomAmount = false;
          state.amount = Number(amountValue || 0);
          state.customAmount = '';
        }
        selectButtons('.df-amount', amountValue, 'data-amount');
        syncCustomAmount();
        syncTotals();
        return;
      }

      var freqBtn = event.target.closest('.df-frequency');
      if (freqBtn) {
        state.frequency = freqBtn.getAttribute('data-frequency') || 'onetime';
        selectButtons('.df-frequency', state.frequency, 'data-frequency');
        syncTotals();
        return;
      }

      var donorBtn = event.target.closest('.df-donor');
      if (donorBtn) {
        state.donationType = donorBtn.getAttribute('data-donation-type') || 'individual';
        selectButtons('.df-donor', state.donationType, 'data-donation-type');
        syncDonorFields();
        return;
      }

      var tributeBtn = event.target.closest('.df-tribute');
      if (tributeBtn) {
        state.tributeType = tributeBtn.getAttribute('data-tribute-type') || 'honor';
        selectButtons('.df-tribute', state.tributeType, 'data-tribute-type');
        return;
      }

      var paymentBtn = event.target.closest('.df-payment');
      if (paymentBtn) {
        state.paymentMethod = paymentBtn.getAttribute('data-payment-method') || 'card';
        selectButtons('.df-payment', state.paymentMethod, 'data-payment-method');
        syncPayment();
        syncTotals();
        return;
      }

      var cardBtn = event.target.closest('.df-card');
      if (cardBtn) {
        state.cardType = cardBtn.getAttribute('data-card-type') || 'visa';
        selectButtons('.df-card', state.cardType, 'data-card-type');
        syncTotals();
        return;
      }

      if (event.target.matches('[data-next]')) {
        var validation = validatePage(config, state, state.step);
        if (!validation.ok) {
          showError(validation.message);
          return;
        }
        state.step = Math.min(steps.length, state.step + 1);
        syncStep();
        syncTotals();
        return;
      }

      if (event.target.matches('[data-enter-manual]')) {
        state.addressMode = 'manual';
        hideAddressSuggestions();
        syncAddressMode();
        return;
      }

      if (event.target.matches('[data-prev]')) {
        state.step = Math.max(1, state.step - 1);
        syncStep();
        syncTotals();
        return;
      }

      if (event.target.matches('[data-submit]')) {
        var valid = { ok: true, message: '' };
        for (var pageIndex = 1; pageIndex <= steps.length; pageIndex += 1) {
          valid = validatePage(config, state, pageIndex);
          if (!valid.ok) {
            showError(valid.message);
            state.step = pageIndex;
            syncStep();
            return;
          }
        }

        var payload = buildPayload(config, state);
        if (options.mode === 'preview') {
          var previewResult = host.querySelector('[data-preview-result]');
          if (previewResult) {
            previewResult.style.display = 'block';
            previewResult.textContent = JSON.stringify(payload, null, 2);
          }
          return;
        }

        var submitButton = host.querySelector('[data-submit]');
        var originalLabel = submitButton ? submitButton.textContent : '';
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.textContent = 'Transferring to Stripe...';
        }

        ensureStripeLoaded()
          .then(function () {
            return fetch(config.endpoints.processDonationApi, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
          })
          .then(function (response) {
            return response.json();
          })
          .then(function (session) {
            if (!session || !session.id) {
              throw new Error('Checkout session was not returned by the API.');
            }
            var publishableKey = session.livemode
              ? config.stripe.livePublishableKey
              : config.stripe.testPublishableKey;
            var stripe = global.Stripe ? global.Stripe(publishableKey) : null;
            if (!stripe) {
              throw new Error('Stripe.js is unavailable.');
            }
            return stripe.redirectToCheckout({ sessionId: session.id });
          })
          .catch(function (error) {
            if (submitButton) {
              submitButton.disabled = false;
              submitButton.textContent = originalLabel;
            }
            showError(error && error.message ? error.message : 'Unable to start checkout.');
          });
      }
    });

    host.querySelectorAll('[data-field]').forEach(function (fieldEl) {
      fieldEl.addEventListener('input', function () {
        handleInput(fieldEl);
      });
      fieldEl.addEventListener('change', function () {
        handleInput(fieldEl);
      });
    });

    host.addEventListener('click', function (event) {
      if (!event.target.closest('[data-address-lookup-row]')) {
        hideAddressSuggestions();
      }
    });

    selectButtons('.df-amount', String(state.amount), 'data-amount');
    selectButtons('.df-frequency', state.frequency, 'data-frequency');
    selectButtons('.df-donor', state.donationType, 'data-donation-type');
    selectButtons('.df-payment', state.paymentMethod, 'data-payment-method');
    selectButtons('.df-card', state.cardType, 'data-card-type');
    selectButtons('.df-tribute', state.tributeType, 'data-tribute-type');

    syncDonorFields();
    syncTribute();
    syncCategoryOther();
    syncCustomAmount();
    syncPayment();
    syncAddressMode();
    syncStep();
    syncTotals();

    return {
      config: config,
      state: state,
      refresh: syncTotals,
    };
  }

  function renderForm(target, rawConfig, renderOptions) {
    var options = renderOptions || {};
    var config = normalizeConfig(rawConfig);
    ensureRuntimeStyle();

    target.classList.add('df-host');
    target.classList.remove('df-embedded');
    target.innerHTML = '';

    var mode = options.mode === 'preview' ? 'embedded' : config.display.mode;
    if (mode === 'embedded') {
      target.classList.add('df-embedded');
    }
    if (mode === 'modal') {
      var openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'df-modal-open';
      openButton.style.setProperty('--df-accent', config.branding.accentColor);
      openButton.textContent = config.display.modalTriggerLabel;

      var modal = document.createElement('div');
      modal.className = 'df-modal';
      var wrap = document.createElement('div');
      wrap.className = 'df-modal-wrap';
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'df-close';
      close.setAttribute('aria-label', 'Close donation form');
      close.textContent = '×';
      var wizardTarget = document.createElement('div');

      wrap.appendChild(close);
      wrap.appendChild(wizardTarget);
      modal.appendChild(wrap);
      target.appendChild(openButton);
      target.appendChild(modal);

      renderWizard(wizardTarget, config, options);

      function openModal() {
        modal.classList.add('is-open');
      }

      function closeModal() {
        modal.classList.remove('is-open');
      }

      openButton.addEventListener('click', openModal);
      close.addEventListener('click', closeModal);
      modal.addEventListener('click', function (event) {
        if (event.target === modal) {
          closeModal();
        }
      });

      global.openDonationModal = openModal;
      global.closeDonationModal = closeModal;
      return { config: config, mode: 'modal' };
    }

    return renderWizard(target, config, options);
  }

  global.DonationFormRuntime = {
    renderForm: renderForm,
    normalizeConfig: normalizeConfig,
    buildPayload: buildPayload,
    totals: totals,
  };
})(window);`;
}

module.exports = {
  getDonationFormRuntimeSource,
};
