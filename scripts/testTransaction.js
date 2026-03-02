const fetch = global.fetch || require('node-fetch');

(async () => {
  try {
    const res = await fetch('http://127.0.0.1:7071/api/transaction', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        amount: 1234,
        frequency: 'onetime',
        customer: {
          email: 'testingasdf@example.com',
          firstName: 'Testingasdf',
          lastName: 'User',
        },
      }),
    });

    console.log('status', res.status);
    const text = await res.text();
    console.log('body', text);
  } catch (err) {
    console.error('error', err);
  }
})();