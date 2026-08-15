// ============================================================================
//  DDMC Food Survey — เซิร์ฟเวอร์ + API เก็บข้อมูลลง PostgreSQL
//  ใช้บน Railway:  ต้องมีตัวแปรแวดล้อม DATABASE_URL (Railway ใส่ให้อัตโนมัติ
//  เมื่อเชื่อม Postgres เข้ากับ service นี้)
// ============================================================================
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const HOME = 'survey.html';

// บัญชีผู้ดูแล — ตั้งค่าผ่าน Variables ใน Railway (ปลอดภัยกว่าเขียนในโค้ด)
const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ddmc2026';

// ---------------------------------------------------------------- ฐานข้อมูล
const DB_URL = process.env.DATABASE_URL;
// Railway ต่อผ่าน internal network ไม่ต้องใช้ SSL, ถ้าต่อจากภายนอกต้องใช้
const needSSL = !!DB_URL && !/localhost|127\.0\.0\.1|\.railway\.internal/.test(DB_URL);

const pool = DB_URL
  ? new Pool({ connectionString: DB_URL, ssl: needSSL ? { rejectUnauthorized: false } : false })
  : null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS responses (
  id             SERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_name     TEXT    NOT NULL,
  last_name      TEXT    NOT NULL,
  age            INTEGER NOT NULL CHECK (age BETWEEN 1 AND 120),
  gender         TEXT    NOT NULL,
  overall        INTEGER NOT NULL CHECK (overall BETWEEN 1 AND 5),
  recommendation TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ratings (
  id          SERIAL PRIMARY KEY,
  response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  menu_id     TEXT    NOT NULL,
  criterion   TEXT    NOT NULL,
  score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  UNIQUE (response_id, menu_id, criterion)
);
CREATE INDEX IF NOT EXISTS ratings_response_idx ON ratings(response_id);
`;

let dbReady = false;
async function initDb(){
  if(!pool){ console.error('!! ไม่พบ DATABASE_URL — กรุณาเชื่อม Postgres เข้ากับ service นี้'); return; }
  try {
    await pool.query(SCHEMA);
    dbReady = true;
    console.log('เชื่อมต่อ PostgreSQL และเตรียมตารางเรียบร้อย');
  } catch (e) {
    console.error('!! เชื่อมต่อฐานข้อมูลไม่สำเร็จ:', e.message);
  }
}

// ------------------------------------------------------------- session admin
const sessions = new Map();                    // token -> เวลาหมดอายุ (ms)
const SESSION_TTL = 8 * 60 * 60 * 1000;        // 8 ชั่วโมง

function newSession(){
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}
function validSession(req){
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const exp = sessions.get(token);
  if(!exp) return false;
  if(exp < Date.now()){ sessions.delete(token); return false; }
  return true;
}
// เทียบรหัสผ่านแบบ constant-time กัน timing attack
function samePassword(a, b){
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ------------------------------------------------------------------ helpers
const CRITERIA = ['taste', 'quantity', 'cleanliness'];

function sendJSON(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(body);
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if(data.length > 1e6){ reject(new Error('payload ใหญ่เกินไป')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch(e){ reject(new Error('รูปแบบ JSON ไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

// ตรวจข้อมูลฝั่งเซิร์ฟเวอร์ ไม่เชื่อฝั่ง client
function validate(b){
  const errs = [];
  const first = String(b.firstName ?? '').trim();
  const last  = String(b.lastName  ?? '').trim();
  const age   = Number(b.age);
  const gender = String(b.gender ?? '').trim();
  const overall = Number(b.overall);
  const rec = String(b.recommendation ?? '').trim();

  if(!first)  errs.push('กรุณากรอกชื่อ');
  if(!last)   errs.push('กรุณากรอกนามสกุล');
  if(!Number.isInteger(age) || age < 1 || age > 120) errs.push('อายุต้องอยู่ระหว่าง 1-120 ปี');
  if(!gender) errs.push('กรุณาเลือกเพศ');
  if(!Number.isInteger(overall) || overall < 1 || overall > 5) errs.push('คะแนนความพึงพอใจโดยรวมไม่ถูกต้อง');
  if(first.length > 100 || last.length > 100) errs.push('ชื่อหรือนามสกุลยาวเกินไป');
  if(rec.length > 2000) errs.push('ข้อเสนอแนะยาวเกิน 2000 ตัวอักษร');

  const ratings = (b.ratings && typeof b.ratings === 'object') ? b.ratings : {};
  const menus = Object.keys(ratings);
  if(!menus.length) errs.push('กรุณาเลือกเมนูที่รับประทานอย่างน้อย 1 เมนู');

  const flat = [];
  for(const menu of menus){
    if(!/^[a-z0-9_-]{1,40}$/i.test(menu)){ errs.push('รหัสเมนูไม่ถูกต้อง'); continue; }
    for(const c of CRITERIA){
      const v = Number(ratings[menu]?.[c]);
      if(!Number.isInteger(v) || v < 1 || v > 5){ errs.push(`คะแนน "${c}" ของเมนู ${menu} ไม่ถูกต้อง`); continue; }
      flat.push([menu, c, v]);
    }
  }
  return { errs, row:{ first, last, age, gender, overall, rec }, flat };
}

// แปลงแถวจาก DB ให้เป็นรูปแบบเดียวกับที่หน้าเว็บใช้
function shape(r, ratingRows){
  const ratings = {};
  for(const t of ratingRows){
    if(t.response_id !== r.id) continue;
    (ratings[t.menu_id] ||= {})[t.criterion] = t.score;
  }
  return {
    id: r.id,
    ts: r.created_at,
    firstName: r.first_name,
    lastName : r.last_name,
    age      : r.age,
    gender   : r.gender,
    menus    : Object.keys(ratings),
    ratings,
    overall  : r.overall,
    recommendation: r.recommendation || ''
  };
}

// -------------------------------------------------------------------- routes
async function api(req, res, url){
  if(!pool || !dbReady){
    return sendJSON(res, 503, { error:'ยังเชื่อมต่อฐานข้อมูลไม่ได้ กรุณาตรวจสอบ DATABASE_URL ใน Railway' });
  }

  // ---- ส่งแบบสอบถาม (สาธารณะ) ----
  if(req.method === 'POST' && url === '/api/responses'){
    const body = await readBody(req);
    const { errs, row, flat } = validate(body);
    if(errs.length) return sendJSON(res, 400, { error: errs.join(' · ') });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO responses (first_name,last_name,age,gender,overall,recommendation)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [row.first, row.last, row.age, row.gender, row.overall, row.rec]
      );
      const id = ins.rows[0].id;
      for(const [menu, criterion, score] of flat){
        await client.query(
          `INSERT INTO ratings (response_id,menu_id,criterion,score) VALUES ($1,$2,$3,$4)`,
          [id, menu, criterion, score]
        );
      }
      await client.query('COMMIT');
      return sendJSON(res, 201, { ok:true, id });
    } catch(e){
      await client.query('ROLLBACK').catch(()=>{});
      console.error('insert error:', e.message);
      return sendJSON(res, 500, { error:'บันทึกข้อมูลไม่สำเร็จ' });
    } finally { client.release(); }
  }

  // ---- เข้าสู่ระบบผู้ดูแล ----
  if(req.method === 'POST' && url === '/api/admin/login'){
    const b = await readBody(req);
    const ok = String(b.username ?? '') === ADMIN_USER && samePassword(b.password ?? '', ADMIN_PASSWORD);
    if(!ok) return sendJSON(res, 401, { error:'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    return sendJSON(res, 200, { token: newSession() });
  }

  // ---- ต่อจากนี้ต้องล็อกอิน ----
  if(url.startsWith('/api/admin/')){
    if(!validSession(req)) return sendJSON(res, 401, { error:'กรุณาเข้าสู่ระบบใหม่ (เซสชันหมดอายุ)' });
  }

  // ---- ดึงคำตอบทั้งหมด ----
  if(req.method === 'GET' && url === '/api/admin/responses'){
    const rs = await pool.query('SELECT * FROM responses ORDER BY id ASC');
    const ts = await pool.query('SELECT * FROM ratings');
    return sendJSON(res, 200, { rows: rs.rows.map(r => shape(r, ts.rows)) });
  }

  // ---- ลบรายคน ----
  const m = url.match(/^\/api\/admin\/responses\/(\d+)$/);
  if(req.method === 'DELETE' && m){
    const out = await pool.query('DELETE FROM responses WHERE id=$1', [Number(m[1])]);
    return sendJSON(res, 200, { ok:true, deleted: out.rowCount });
  }

  // ---- ลบทั้งหมด ----
  if(req.method === 'DELETE' && url === '/api/admin/responses'){
    const out = await pool.query('DELETE FROM responses');
    return sendJSON(res, 200, { ok:true, deleted: out.rowCount });
  }

  return sendJSON(res, 404, { error:'ไม่พบ endpoint นี้' });
}

// ------------------------------------------------------------ static + server
const TYPES = {
  '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.csv':'text/csv; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  if(url.startsWith('/api/')){
    try { await api(req, res, url); }
    catch(e){
      console.error('api error:', e.message);
      if(!res.headersSent) sendJSON(res, 500, { error:'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
    return;
  }

  if(url === '/healthz') return sendJSON(res, 200, { ok:true, db:dbReady });

  // ---- ไฟล์ static ----
  const rel  = (url === '/' || url === '') ? '/' + HOME : url;
  const file = path.join(ROOT, path.normalize(rel));
  if(file !== ROOT && !file.startsWith(ROOT + path.sep)){
    res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'});
    return res.end('403 Forbidden');
  }
  // ไม่ให้ดาวน์โหลดไฟล์ระบบ
  if(/^(server\.js|package(-lock)?\.json)$/i.test(path.basename(file))){
    res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'});
    return res.end('403 Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if(err){
      res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'});
      return res.end('<h1>404</h1><p>ไม่พบหน้าที่ต้องการ — <a href="/">กลับไปหน้าแบบสอบถาม</a></p>');
    }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'});
    res.end(data);
  });
});

initDb().finally(() => {
  server.listen(PORT, () => console.log('DDMC Food Survey listening on port ' + PORT));
});
