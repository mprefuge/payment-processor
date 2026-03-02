#!/usr/bin/env node
// Simple interactive helper that searches Stripe for a customer by email + name
// and creates one if none is found.  Useful for manual experimentation during
development.

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

  const { data } = await stripe.customers.search({
    query: `email:'${sanitizedEmail}' AND name:'${sanitizedFullName}'`,
    limit: 10,
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
    if (matches.length > 0) {
      console.log('Found existing customer(s):');
      matches.forEach(c => console.log(JSON.stringify(c, null, 2)));
    } else {
      console.log('No customer found, creating a new one...');
      const newCust = await createCustomer(email.trim(), fullName.trim());
      console.log('Created customer:');
      console.log(JSON.stringify(newCust, null, 2));
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    rl.close();
  }
}

main();
