#!/usr/bin/env node
// CommonJS variant of the interactive Stripe customer helper.  Use this when
// running under the project which defaults to CommonJS for .cjs files.

const Stripe = require('stripe');
const readline = require('readline');

const STRIPE_KEY = process.env.STRIPE_API_KEY;
if (!STRIPE_KEY) {
  console.error('Please set STRIPE_API_KEY in your environment.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2022-11-15' });

function escapeStripeQueryValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function searchCustomer(email, fullName) {
  const sanitizedEmail = escapeStripeQueryValue(email);
  const sanitizedFullName = escapeStripeQueryValue(fullName);

  // search by email only, then verify name locally
  const { data } = await stripe.customers.search({
    query: `email:'${sanitizedEmail}'`,
    limit: 20,
  });

  // filter exact name match (case insensitive)
  return data.filter(c => c.name && c.name.toLowerCase() === fullName.toLowerCase());
}

async function createCustomer(email, fullName) {
  return stripe.customers.create({
    email,
    name: fullName,
  });
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (q) => new Promise(resolve => rl.question(q, resolve));

  try {
    const email = await question('Enter customer email: ');
    const fullName = await question('Enter customer full name: ');

    if (!email || !fullName) {
      console.error('Email and name are required.');
      process.exit(1);
    }

    console.log(`Searching Stripe for ${email} / ${fullName}...`);
    const matches = await searchCustomer(email.trim(), fullName.trim());
    let finalCustomer = null;
    if (matches.length > 0) {
      console.log('Found existing customer(s):');
      matches.forEach(c => console.log(JSON.stringify(c, null, 2)));
      finalCustomer = matches[0];
    } else {
      console.log('No customer found, creating a new one...');
      const newCust = await createCustomer(email.trim(), fullName.trim());
      console.log('Created customer:');
      console.log(JSON.stringify(newCust, null, 2));
      finalCustomer = newCust;
    }

    // Prompt for optional Salesforce ID to persist
    const sfid = await question('Enter Salesforce contact ID to associate (leave blank to skip): ');
    if (sfid && sfid.trim()) {
      try {
        await stripe.customers.update(finalCustomer.id, {
          metadata: { ...finalCustomer.metadata, salesforce_id: sfid.trim() },
        });
        console.log('Updated customer metadata with salesforce_id');
      } catch (err) {
        console.error('Failed to update customer metadata:', err);
      }
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    rl.close();
  }
}

main();
