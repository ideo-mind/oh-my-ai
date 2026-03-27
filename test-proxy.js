const http = require('node:http');
http.get('http://localhost:8990/gemini/models/gemini-2.5-flash:streamGenerateContent?alt=sse', (res) => {
  console.log('STATUS:', res.statusCode);
  console.log('HEADERS:', res.headers);
  res.on('data', d => process.stdout.write(d));
}).on('error', e => console.error(e));
