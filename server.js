// เซิร์ฟเวอร์ static เล็ก ๆ สำหรับ deploy บน Railway (ไม่ใช้ dependency ใด ๆ)
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const HOME = 'survey.html';          // ไฟล์แบบสอบถามหลัก

const TYPES = {
  '.html':'text/html; charset=utf-8',
  '.css' :'text/css; charset=utf-8',
  '.js'  :'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.csv' :'text/csv; charset=utf-8',
  '.png' :'image/png',
  '.jpg' :'image/jpeg',
  '.jpeg':'image/jpeg',
  '.svg' :'image/svg+xml',
  '.ico' :'image/x-icon'
};

http.createServer((req, res) => {
  // ตัด query string ออก และให้ "/" ชี้ไปที่หน้าแบบสอบถาม
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/' + HOME;

  // กัน path traversal (../../etc/passwd)
  const file = path.join(ROOT, path.normalize(rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'});
    return res.end('403 Forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'});
      return res.end('<h1>404</h1><p>ไม่พบหน้าที่ต้องการ — <a href="/">กลับไปหน้าแบบสอบถาม</a></p>');
    }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'});
    res.end(data);
  });
}).listen(PORT, () => console.log('DDMC Food Survey running on port ' + PORT));
