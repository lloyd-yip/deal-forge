const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Proxy LinkedIn avatar — LinkedIn blocks direct hotlinking
  if (urlPath === '/lloyd-avatar') {
    const linkedinUrl = 'https://media.licdn.com/dms/image/v2/C4E03AQEtIxMkjlDmyA/profile-displayphoto-shrink_200_200/0/1638042721905';
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Referer': 'https://www.linkedin.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      }
    };
    https.get(linkedinUrl, options, (upstream) => {
      if (upstream.statusCode === 200) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        upstream.pipe(res);
      } else {
        // Return a 1x1 transparent PNG on failure so onerror fires cleanly
        res.writeHead(404);
        res.end();
      }
    }).on('error', () => { res.writeHead(404); res.end(); });
    return;
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/mockup-portal.html';
  if (urlPath === '/dashboard') urlPath = '/mockup-dashboard.html';

  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Deal Forge mockup running on port ${PORT}`));
