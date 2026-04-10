const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { put } = require('@vercel/blob');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection - supports Vercel Postgres
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
if (!connectionString) {
  console.error('ERROR: POSTGRES_URL environment variable is not set!');
  console.error('Please go to Vercel dashboard → Project → Settings → Environment Variables');
  console.error('Add POSTGRES_URL from your Vercel Postgres connection string');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false
});

// For Vercel serverless: we use memoryStorage, because Vercel filesystem is read-only at runtime
// After user uploads in admin, we save it to public/uploads and it needs to be committed to git
// to be available to Vercel CDN. This is okay because:
// 1. Admin uploads are very infrequent
// 2. Images are small (<5MB)
// 3. After upload, you just need to git commit/push and Vercel deploys it
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('只允許上傳圖片文件'));
    }
  }
});

// Ensure upload directory exists locally (we already created it with .gitkeep)
const uploadDir = path.join(__dirname, 'public', 'uploads');

// Test connection
if (connectionString) {
  pool.connect((err, client, release) => {
    if (err) {
      console.error('Error connecting to PostgreSQL:', err);
    } else {
      console.log('Connected to PostgreSQL database');
      release();
    }
  });
}

// Promisify query
function dbQuery(sql, params = [], client = pool) {
  return client.query(sql, params);
}

// Multer middleware for mixed content-type support
// upload.any() allows file uploads, we just ignore files for now (text fields are parsed)
const anyMulter = upload.any();
const multerUnlessJson = (req, res, next) => {
  const contentType = req.get('Content-Type') || '';
  if (contentType.includes('multipart/form-data')) {
    anyMulter(req, res, next);
  } else {
    next();
  }
};

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const isVercel = !!process.env.VERCEL;
if (isVercel) {
  app.set('trust proxy', 1);
}

if (isVercel && !process.env.SESSION_SECRET) {
  console.error('WARNING: SESSION_SECRET is not set on Vercel. Using random secret (sessions will reset on restart).');
}

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const twdPerHkd = (() => {
  const raw =
    process.env.TWD_PER_HKD ||
    process.env.HKD_TO_TWD ||
    process.env.FX_TWD_PER_HKD ||
    '4.0';
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 4.0;
})();

function formatMoney(value, maxFractionDigits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('zh-HK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits
  });
}

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isVercel
    },
    ...(connectionString
      ? {
          store: new pgSession({
            pool,
            createTableIfMissing: true
          })
        }
      : {})
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.isAdmin = !!req.session.user?.is_admin;
  res.locals.twdPerHkd = twdPerHkd;
  res.locals.formatMoney = formatMoney;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.redirect('/admin/login');
  }
  next();
}

// Create tables if not exists
async function initDatabase() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password_hash TEXT,
        contact TEXT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS raffles (
        id SERIAL PRIMARY KEY,
        title TEXT,
        description TEXT,
        type TEXT DEFAULT 'ichiban',
        total_boxes INTEGER,
        price_per_box REAL,
        cover_image TEXT NULL,
        remaining_boxes INTEGER,
        num_pools INTEGER DEFAULT 1,
        start_date TIMESTAMP,
        end_date TIMESTAMP,
        status TEXT DEFAULT 'active',
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS prizes (
        id SERIAL PRIMARY KEY,
        raffle_id INTEGER,
        tier TEXT,
        name TEXT,
        description TEXT,
        image_url TEXT,
        total_count INTEGER,
        remaining_count INTEGER,
        is_final BOOLEAN DEFAULT FALSE,
        pool_number INTEGER NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(raffle_id) REFERENCES raffles(id)
      );

      CREATE TABLE IF NOT EXISTS entries (
        id SERIAL PRIMARY KEY,
        raffle_id INTEGER,
        prize_id INTEGER,
        buyer_name TEXT,
        buyer_contact TEXT,
        user_id INTEGER NULL,
        verification_code_id INTEGER NULL,
        drawn_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(raffle_id) REFERENCES raffles(id),
        FOREIGN KEY(prize_id) REFERENCES prizes(id)
      );

      CREATE TABLE IF NOT EXISTS winners (
        id SERIAL PRIMARY KEY,
        entry_id INTEGER,
        raffle_id INTEGER,
        prize_id INTEGER,
        buyer_name TEXT,
        user_id INTEGER NULL,
        drawn_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(entry_id) REFERENCES entries(id),
        FOREIGN KEY(raffle_id) REFERENCES raffles(id),
        FOREIGN KEY(prize_id) REFERENCES prizes(id)
      );

      CREATE TABLE IF NOT EXISTS verification_codes (
        id SERIAL PRIMARY KEY,
        raffle_id INTEGER,
        code TEXT UNIQUE,
        prize_id INTEGER,
        used BOOLEAN DEFAULT FALSE,
        used_at TIMESTAMP NULL,
        user_id INTEGER NULL,
        assigned_user_id INTEGER NULL,
        assigned_at TIMESTAMP NULL,
        assigned_by INTEGER NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(raffle_id) REFERENCES raffles(id),
        FOREIGN KEY(prize_id) REFERENCES prizes(id)
      );
    `);

    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_user_id INTEGER NULL');
    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP NULL');
    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_by INTEGER NULL');
    await dbQuery('ALTER TABLE raffles ADD COLUMN IF NOT EXISTS cover_image TEXT NULL');
    await dbQuery('ALTER TABLE entries ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMP NULL');

    const adminResult = await dbQuery('SELECT COUNT(*) as count FROM users WHERE is_admin = 1');
    const hasAdmin = adminResult.rows[0]?.count !== '0';

    const seedAdminUsername =
      process.env.SEED_ADMIN_USERNAME ||
      process.env.ADMIN_LOGIN ||
      process.env.ADMIN_USERNAME;
    const seedAdminPassword =
      process.env.SEED_ADMIN_PASSWORD ||
      process.env.ADMIN_PASSWORD;
    const allowReset =
      process.env.SEED_ADMIN_RESET === '1' ||
      process.env.RESET_ADMIN_PASSWORD === '1';

    if (seedAdminUsername && seedAdminPassword) {
      const existingUserResult = await dbQuery('SELECT id, is_admin FROM users WHERE username = $1 LIMIT 1', [
        seedAdminUsername
      ]);
      const exists = existingUserResult.rows.length > 0;

      if (!exists) {
        const passwordHash = await bcrypt.hash(seedAdminPassword, 10);
        await dbQuery(
          'INSERT INTO users (username, password_hash, contact, is_admin) VALUES ($1, $2, $3, $4)',
          [seedAdminUsername, passwordHash, null, 1]
        );
        console.log('Admin user seeded from environment variables.');
      } else if (allowReset || !hasAdmin) {
        const passwordHash = await bcrypt.hash(seedAdminPassword, 10);
        await dbQuery('UPDATE users SET password_hash = $1, is_admin = 1 WHERE username = $2', [
          passwordHash,
          seedAdminUsername
        ]);
        console.log('Admin user password updated from environment variables.');
      }
    }

    console.log('Database initialized');
  } catch (err) {
    console.error('Error initializing database:', err);
    throw err;
  }
}

const dbInit = (async () => {
  if (!connectionString) return;
  await initDatabase();
})();

app.use(async (req, res, next) => {
  if (!connectionString) return next();
  try {
    await dbInit;
    next();
  } catch (err) {
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ error: 'Database init failed' });
    }
    return res.status(500).send('Database init failed');
  }
});

// ===== Auth Routes (Public) =====

// User login page
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/my');
  }
  res.render('login');
});

// User register page
app.get('/register', (req, res) => {
  if (req.session.user) {
    return res.redirect('/my');
  }
  res.render('register');
});

// User my page - list my raffle entries
app.get('/my', requireAuth, (req, res) => {
  res.render('my');
});

// Register API
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, contact } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '請填寫用戶名和密碼' });
    }

    // Check if username exists
    const existing = await dbQuery('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: '用戶名已存在' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await dbQuery(`
      INSERT INTO users (username, password_hash, contact, is_admin)
      VALUES ($1, $2, $3, 0)
      RETURNING id, username, contact, is_admin, created_at
    `, [username, passwordHash, contact || null]);

    const user = result.rows[0];
    req.session.user = user;
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Public Routes =====

// Home page - list all active raffles
app.get('/', async (req, res) => {
  try {
    if (!connectionString) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="zh-HK">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>設定錯誤 - Ichiban Kuji Raffle</title>
          <style>body{font-family:Arial,sans-serif;max-width:800px;margin:50px auto;padding:20px}h1{color:#e74c3c}pre{background:#f5f5f5;padding:10px;border-radius:4px;overflow:auto}</style>
        </head>
        <body>
          <h1>⚠️  數據庫連接設定錯誤</h1>
          <p><strong>問題:</strong> 環境變量 <code>POSTGRES_URL</code> 未設定</p>
          <h3>解決方法:</h3>
          <ol>
            <li>去 Vercel 後台 → 這個項目 → Settings → Environment Variables</li>
            <li>添加 <code>POSTGRES_URL</code>，值係你嘅 Vercel Postgres 連接字符串</li>
            <li>重新部署項目</li>
          </ol>
          <p>如果你仲未創建 Vercel Postgres 數據庫:</p>
          <ol>
            <li>在 Vercel dashboard → Storage → Create Database → Vercel Postgres</li>
            <li>創建完成後複製 Connection String</li>
            <li>添加到 Environment Variables 命名為 <code>POSTGRES_URL</code></li>
            <li>Redeploy</li>
          </ol>
        </body>
        </html>
      `);
    }
    const result = await dbQuery(`
      SELECT id, title, description, total_boxes, remaining_boxes, price_per_box, status, cover_image
      FROM raffles
      WHERE status = 'active'
      ORDER BY created_at DESC
    `);
    res.render('index', { raffles: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html lang="zh-HK">
      <head>
        <meta charset="UTF-8">
        <title>Server Error</title>
        <style>body{font-family:Arial,sans-serif;max-width:800px;margin:50px auto;padding:20px}h1{color:#e74c3c}pre{background:#f5f5f5;padding:10px;border-radius:4px;overflow:auto}</style>
      </head>
      <body>
        <h1>❌ Internal Server Error</h1>
        <p><strong>Error:</strong></p>
        <pre>${err.message}</pre>
        <p>Check Vercel logs for more details.</p>
      </body>
      </html>
    `);
  }
});

// Raffle detail page - show remaining prizes
app.get('/raffle/:id', async (req, res) => {
  try {
    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1', [req.params.id]);
    if (raffleResult.rows.length === 0) {
      return res.status(404).send('抽獎活動不存在');
    }
    const raffle = raffleResult.rows[0];

    // Get all prizes grouped by tier
    const prizesResult = await dbQuery(`
      SELECT * FROM prizes
      WHERE raffle_id = $1
      ORDER BY pool_number, is_final DESC, tier
    `, [req.params.id]);
    const prizes = prizesResult.rows;

    // Group by pool for final prizes
    const pools = [];
    for (let i = 1; i <= raffle.num_pools; i++) {
      const poolPrizes = prizes.filter(p => p.pool_number === i || p.pool_number === null && i === 1);
      pools.push({
        number: i,
        prizes: poolPrizes
      });
    }

    // Get recent winners
    const winnersResult = await dbQuery(`
      SELECT w.*,
             CASE WHEN p.tier IN ('A','B','C','D','E','F','G','H') THEN p.name ELSE '親筆簽名拍立得' END as prize_name,
             p.tier as prize_tier
      FROM winners w
      JOIN prizes p ON w.prize_id = p.id
      WHERE w.raffle_id = $1
      ORDER BY w.drawn_at DESC
      LIMIT 20
    `, [req.params.id]);

    const remainingCount = raffle.remaining_boxes;

    res.render('raffle', {
      raffle,
      pools,
      winners: winnersResult.rows,
      remainingCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error: ' + err.message);
  }
});

// API: Get remaining prize counts
app.get('/api/raffle/:id/prizes', async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT id, tier, name, remaining_count, total_count, is_final, pool_number
      FROM prizes
      WHERE raffle_id = $1
      ORDER BY pool_number, is_final DESC, tier
    `, [req.params.id]);
    res.json({ prizes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Get recent winners
app.get('/api/raffle/:id/winners', async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT w.*,
             CASE WHEN p.tier IN ('A','B','C','D','E','F','G','H') THEN p.name ELSE '親筆簽名拍立得' END as prize_name,
             p.tier as prize_tier
      FROM winners w
      JOIN prizes p ON w.prize_id = p.id
      WHERE w.raffle_id = $1
      ORDER BY w.drawn_at DESC
      LIMIT 20
    `, [req.params.id]);
    res.json({ winners: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Draw prize endpoint - requires verification code
app.post('/api/raffle/:id/draw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, contact, code } = req.body;
    const raffleId = parseInt(req.params.id);
    const userId = req.session.user?.id || null;

    if (!raffleId) {
      await client.release();
      return res.status(400).json({ error: '抽獎活動ID無效' });
    }
    if (!code) {
      await client.release();
      return res.status(400).json({ error: '需要輸入抽獎驗證碼' });
    }
    if (!username || !contact) {
      await client.release();
      return res.status(400).json({ error: '需要填寫會員用戶名和聯絡方式' });
    }

    await client.query('BEGIN');

    const codeResult = await dbQuery(
      `
        SELECT vc.*, au.username as assigned_username
        FROM verification_codes vc
        LEFT JOIN users au ON vc.assigned_user_id = au.id
        WHERE vc.code = $1 AND vc.raffle_id = $2 AND vc.used = false
        FOR UPDATE OF vc
      `,
      [code, raffleId],
      client
    );
    if (codeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '驗證碼無效或已使用' });
    }
    const verificationCode = codeResult.rows[0];

    if (verificationCode.assigned_user_id) {
      if (!req.session.user) {
        await client.query('ROLLBACK');
        await client.release();
        return res.status(401).json({ error: '此驗證碼已分配給會員，請用會員登入後再抽獎' });
      }
      if (Number(req.session.user.id) !== Number(verificationCode.assigned_user_id)) {
        await client.query('ROLLBACK');
        await client.release();
        const assignedUsername = verificationCode.assigned_username || '指定會員';
        const currentUsername = req.session.user.username || String(req.session.user.id);
        return res.status(403).json({ error: `此驗證碼已分配給會員 ${assignedUsername}，你而家登入緊 ${currentUsername}` });
      }
    }

    const effectiveUsername = req.session.user?.username || username;

    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1 FOR UPDATE', [raffleId], client);
    if (raffleResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '抽獎活動不存在' });
    }
    const raffle = raffleResult.rows[0];

    if (raffle.status !== 'active') {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '抽獎活動已關閉' });
    }
    if (raffle.remaining_boxes <= 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '所有盒子已經抽完' });
    }

    // Get the pre-allocated prize from verification code
    if (!verificationCode.prize_id) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '驗證碼資料錯誤，缺少預分配獎項' });
    }

    const prizeResult = await dbQuery(
      `
        SELECT * FROM prizes
        WHERE id = $1 AND raffle_id = $2 AND remaining_count > 0
        FOR UPDATE
      `,
      [verificationCode.prize_id, raffleId],
      client
    );
    if (prizeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(400).json({ error: '此獎項已經被抽完，驗證碼無效' });
    }
    const drawnPrize = prizeResult.rows[0];

    // Update prize count
    const prizeUpdate = await dbQuery(
      `
        UPDATE prizes
          SET remaining_count = remaining_count - 1
          WHERE id = $1 AND remaining_count > 0
          RETURNING id, name, tier, description, image_url, is_final, remaining_count
      `,
      [drawnPrize.id],
      client
    );
    const updatedPrize = prizeUpdate.rows[0];

    // Update raffle remaining boxes
    const raffleUpdate = await dbQuery(
      `
        UPDATE raffles
          SET remaining_boxes = remaining_boxes - 1
          WHERE id = $1 AND remaining_boxes > 0
          RETURNING remaining_boxes
      `,
      [raffleId],
      client
    );
    const remainingBoxes = raffleUpdate.rows[0].remaining_boxes;
    if (remainingBoxes <= 0) {
      await dbQuery(`UPDATE raffles SET status = 'completed' WHERE id = $1`, [raffleId], client);
    }

    // Mark code as used
    const codeUpdate = await dbQuery(
      `
        UPDATE verification_codes
          SET used = true, used_at = CURRENT_TIMESTAMP, user_id = $1
          WHERE id = $2 AND used = false
          RETURNING id
      `,
      [userId, verificationCode.id],
      client
    );
    if (codeUpdate.rows.length === 0) {
      await client.query('ROLLBACK');
      await client.release();
      return res.status(409).json({ error: '驗證碼已被使用，請檢查後重試' });
    }

    // Create entry
    const entryResult = await dbQuery(
      `
        INSERT INTO entries (raffle_id, prize_id, buyer_name, buyer_contact, user_id, verification_code_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
      `,
      [raffleId, updatedPrize.id, effectiveUsername, contact, userId, verificationCode.id],
      client
    );
    const entryId = entryResult.rows[0].id;

    await dbQuery(
      `
        INSERT INTO winners (entry_id, raffle_id, prize_id, buyer_name, user_id)
          VALUES ($1, $2, $3, $4, $5)
      `,
      [entryId, raffleId, updatedPrize.id, effectiveUsername, userId],
      client
    );

    await client.query('COMMIT');
    await client.release();

    const majorTiers = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const displayPrizeName = majorTiers.has(updatedPrize.tier) ? updatedPrize.name : '親筆簽名拍立得';

    res.json({
      success: true,
      entryId,
      prize: { ...updatedPrize, name: displayPrizeName },
      remaining_boxes: remainingBoxes
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    console.error(err);
    await client.release();
    res.status(500).json({ error: 'Server error' });
  }
});

// Batch draw - process multiple verification codes at once
app.post('/api/raffle/:id/batch-draw', async (req, res) => {
  const client = await pool.connect();
  try {
    const { codes, username, contact } = req.body;
    const raffleId = parseInt(req.params.id);
    const userId = req.session.user?.id || null;

    if (!raffleId) {
      await client.release();
      return res.status(400).json({ error: '抽獎活動ID無效' });
    }
    if (!codes || !Array.isArray(codes) || codes.length === 0) {
      await client.release();
      return res.status(400).json({ error: '需要輸入驗證碼列表' });
    }
    if (!username || !contact) {
      await client.release();
      return res.status(400).json({ error: '需要填寫會員用戶名和聯絡方式' });
    }
    if (codes.length > 50) {
      await client.release();
      return res.status(400).json({ error: '批量抽獎最多支持 50 個驗證碼' });
    }

    // Check raffle exists and is active
    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1', [raffleId], client);
    if (raffleResult.rows.length === 0) {
      await client.release();
      return res.status(404).json({ error: '抽獎活動不存在' });
    }
    const raffle = raffleResult.rows[0];
    if (raffle.status !== 'active') {
      await client.release();
      return res.status(400).json({ error: '抽獎活動已關閉' });
    }

    const majorTiers = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const results = [];
    let successCount = 0;

    // Process each code sequentially
    for (const code of codes) {
      const trimmedCode = code.trim();
      if (!trimmedCode) continue;

      try {
        await client.query('BEGIN');

        // Find unused code
        const codeResult = await dbQuery(
          `
            SELECT vc.*, au.username as assigned_username
            FROM verification_codes vc
            LEFT JOIN users au ON vc.assigned_user_id = au.id
            WHERE vc.code = $1 AND vc.raffle_id = $2 AND vc.used = false
            FOR UPDATE OF vc
          `,
          [trimmedCode, raffleId],
          client
        );

        if (codeResult.rows.length === 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '驗證碼無效或已使用'
          });
          continue;
        }

        const verificationCode = codeResult.rows[0];

        // Check assigned user
        if (verificationCode.assigned_user_id) {
          if (!req.session.user) {
            await client.query('ROLLBACK');
            results.push({
              code: trimmedCode,
              success: false,
              error: '此驗證碼已分配給會員，請登入後再抽獎'
            });
            continue;
          }
          if (Number(req.session.user.id) !== Number(verificationCode.assigned_user_id)) {
            const assignedUsername = verificationCode.assigned_username || '指定會員';
            const currentUsername = req.session.user.username || String(req.session.user.id);
            await client.query('ROLLBACK');
            results.push({
              code: trimmedCode,
              success: false,
              error: `此驗證碼已分配給 ${assignedUsername}，目前登入係 ${currentUsername}`
            });
            continue;
          }
        }

        // Check that prize still exists and is available
        if (!verificationCode.prize_id) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '驗證碼未預分配獎項，資料錯誤'
          });
          continue;
        }

        const prizeCheck = await dbQuery(
          `SELECT * FROM prizes WHERE id = $1 AND raffle_id = $2 AND remaining_count > 0`,
          [verificationCode.prize_id, raffleId],
          client
        );
        if (prizeCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '對應獎項已經抽完'
          });
          continue;
        }
        const drawnPrize = prizeCheck.rows[0];

        // Check remaining boxes
        if (raffle.remaining_boxes - successCount <= 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '所有盒子已經抽完'
          });
          continue;
        }

        // Update prize count
        const prizeUpdate = await dbQuery(
          `
            UPDATE prizes
              SET remaining_count = remaining_count - 1
              WHERE id = $1 AND remaining_count > 0
              RETURNING id, name, tier, description, is_final, remaining_count
          `,
          [drawnPrize.id],
          client
        );
        const updatedPrize = prizeUpdate.rows[0];

        // Mark code as used
        const codeUpdate = await dbQuery(
          `
            UPDATE verification_codes
              SET used = true, used_at = CURRENT_TIMESTAMP, user_id = $1
              WHERE id = $2 AND used = false
              RETURNING id
          `,
          [userId, verificationCode.id],
          client
        );
        if (codeUpdate.rows.length === 0) {
          await client.query('ROLLBACK');
          results.push({
            code: trimmedCode,
            success: false,
            error: '驗證碼已被使用'
          });
          continue;
        }

        const effectiveUsername = req.session.user?.username || username;

        // Insert entry
        const entryResult = await dbQuery(
          `
            INSERT INTO entries (raffle_id, prize_id, buyer_name, buyer_contact, user_id, verification_code_id)
              VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING id
          `,
          [raffleId, updatedPrize.id, effectiveUsername, contact, userId, verificationCode.id],
          client
        );
        const entryId = entryResult.rows[0].id;

        // Insert winner
        await dbQuery(
          `
            INSERT INTO winners (entry_id, raffle_id, prize_id, buyer_name, user_id)
              VALUES ($1, $2, $3, $4, $5)
          `,
          [entryId, raffleId, updatedPrize.id, effectiveUsername, userId],
          client
        );

        // Update raffle remaining boxes
        await dbQuery(
          `
            UPDATE raffles
              SET remaining_boxes = remaining_boxes - 1
              WHERE id = $1
          `,
          [raffleId],
          client
        );

        const displayPrizeName = majorTiers.has(updatedPrize.tier) ? updatedPrize.name : '親筆簽名拍立得';

        await client.query('COMMIT');

        successCount++;

        results.push({
          code: trimmedCode,
          success: true,
          entryId,
          prize: { ...updatedPrize, name: displayPrizeName }
        });
      } catch (itemErr) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('Rollback failed for item:', trimmedCode, rollbackErr);
        }
        results.push({
          code: trimmedCode,
          success: false,
          error: '系統錯誤: ' + String(itemErr.message)
        });
      }
    }

    // Final update - if all boxes done, close raffle
    const finalCheck = await dbQuery('SELECT remaining_boxes FROM raffles WHERE id = $1', [raffleId], client);
    const finalRemaining = finalCheck.rows[0].remaining_boxes;
    if (finalRemaining <= 0) {
      await dbQuery("UPDATE raffles SET status = 'completed' WHERE id = $1", [raffleId], client);
    }

    await client.release();

    res.json({
      success: true,
      total: codes.length,
      successCount,
      results
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    console.error(err);
    await client.release();
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Admin Routes =====

// Upload image endpoint for admin (cover images)
// Uses Vercel Blob for cloud storage when BLOB_READ_WRITE_TOKEN is available
// Falls back to local file storage for development
app.post('/api/admin/upload-image', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '沒有上傳文件' });
    }
    
    // If Vercel Blob token is available, use cloud storage (works everywhere including Vercel live)
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `cover-${uniqueSuffix}${ext}`;
      
      // Upload to Vercel Blob
      const blob = await put(filename, req.file.buffer, {
        access: 'public',
        contentType: req.file.mimetype
      });
      
      // Return the permanent URL from Vercel Blob
      res.json({ 
        success: true, 
        url: blob.url,
        filename
      });
    } else {
      // No Blob token - fall back to local file storage
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = 'cover-' + uniqueSuffix + ext;
      const fullPath = path.join(uploadDir, filename);
      
      try {
        fs.writeFileSync(fullPath, req.file.buffer);
        const imageUrl = `/uploads/${filename}`;
        res.json({ 
          success: true, 
          url: imageUrl,
          filename
        });
      } catch (writeErr) {
        res.status(500).json({ 
          error: 'Vercel Blob 未配置，且本地文件系統只讀。請在 Vercel 項目設置添加 BLOB_READ_WRITE_TOKEN 環境變量，或者手動粘帖圖片 URL。' 
        });
      }
    }
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || '上傳失敗' });
  }
});

// Admin dashboard
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.redirect('/admin/login');
    }
    const result = await dbQuery(`
      SELECT * FROM raffles
      ORDER BY created_at DESC
    `);
    res.render('admin/dashboard', { raffles: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error: ' + err.message);
  }
});

// Create raffle page
app.get('/admin/create', requireAdmin, (req, res) => {
  res.render('admin/create');
});

// Edit raffle page
app.get('/admin/raffles/:id/edit', requireAdmin, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.redirect('/admin/login');
    }
    const result = await dbQuery(`
      SELECT * FROM raffles WHERE id = $1
    `, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('代抽服務不存在');
    }
    const raffle = result.rows[0];
    res.render('admin/edit', { raffle });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error: ' + err.message);
  }
});

// Update raffle API
app.put('/api/admin/raffles/:id/update', requireAdmin, multerUnlessJson, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    
    const raffleId = req.params.id;
    const title = req.body.title ? req.body.title.trim() : '';
    const description = req.body.description || '';
    const total_boxes = req.body.total_boxes;
    const price_per_box = req.body.price_per_box;
    const cover_image = req.body.cover_image || null;
    const status = req.body.status || 'draft';
    
    if (!title || !total_boxes || !price_per_box) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }
    
    const parsedTotalBoxes = parseInt(total_boxes, 10);
    const parsedPricePerBox = parseFloat(price_per_box);
    
    if (isNaN(parsedTotalBoxes) || parsedTotalBoxes < 1) {
      return res.status(400).json({ error: '總盒數必須是大於 0 的數字' });
    }
    if (isNaN(parsedPricePerBox) || parsedPricePerBox <= 0) {
      return res.status(400).json({ error: '每盒價格必須是大於 0 的數字' });
    }
    
    // Get current remaining to adjust if total boxes changed
    const current = await dbQuery(`SELECT remaining_boxes FROM raffles WHERE id = $1`, [raffleId]);
    let remaining = parsedTotalBoxes;
    if (current.rows.length > 0) {
      // If decreasing total, adjust remaining proportionally (simplified)
      remaining = Math.min(current.rows[0].remaining_boxes, parsedTotalBoxes);
    }
    
    await dbQuery(`
      UPDATE raffles 
      SET title = $1, description = $2, cover_image = $3, total_boxes = $4, price_per_box = $5, remaining_boxes = $6, status = $7
      WHERE id = $8
    `, [
      title,
      description || '',
      cover_image || null,
      parsedTotalBoxes,
      parsedPricePerBox,
      remaining,
      status,
      raffleId
    ]);
    
    res.json({ success: true, raffleId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Create new raffle API
// Note: Frontend sends FormData for optional image upload, need multer to parse multipart
// Auto-detect content-type: multer for multipart, pass-through for json
app.post('/api/admin/raffles/create', requireAdmin, multerUnlessJson, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    // Get from req.body (express parses both json and urlencoded/form-data)
    const title = req.body.title ? req.body.title.trim() : '';
    const description = req.body.description || '';
    const total_boxes = req.body.total_boxes;
    const price_per_box = req.body.price_per_box;
    const num_pools = req.body.num_pools;
    const cover_image = req.body.cover_image || null;

    // Debug logging
    console.log('Create raffle request:', { title, total_boxes, price_per_box, num_pools });

    if (!title || !total_boxes || !price_per_box) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }
    
    const parsedTotalBoxes = parseInt(total_boxes, 10);
    const parsedPricePerBox = parseFloat(price_per_box);
    
    if (isNaN(parsedTotalBoxes) || parsedTotalBoxes < 1) {
      return res.status(400).json({ error: '總盒數必須是大於 0 的數字' });
    }
    if (isNaN(parsedPricePerBox) || parsedPricePerBox <= 0) {
      return res.status(400).json({ error: '每盒價格必須是大於 0 的數字' });
    }

    const result = await dbQuery(`
      INSERT INTO raffles (title, description, cover_image, total_boxes, price_per_box, remaining_boxes, num_pools, status, created_by)
      VALUES ($1, $2, $3, $4, $5, $4, $6, 'draft', $7)
      RETURNING id
    `, [
      title,
      description || '',
      cover_image || null,
      parsedTotalBoxes,
      parsedPricePerBox,
      parseInt(num_pools || 1, 10),
      req.session.user.id
    ]);

    res.json({ raffleId: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.get('/admin/raffles/:id/codes', requireAdmin, async (req, res) => {
  try {
    const raffleId = parseInt(req.params.id);
    if (!raffleId) {
      return res.status(400).send('抽獎活動ID無效');
    }
    const raffleResult = await dbQuery('SELECT id, title FROM raffles WHERE id = $1', [raffleId]);
    if (raffleResult.rows.length === 0) {
      return res.status(404).send('抽獎活動不存在');
    }
    res.render('admin/codes', { raffleId, title: raffleResult.rows[0].title });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.get('/admin/login', (req, res) => {
  if (req.session.user?.is_admin) {
    return res.redirect('/admin');
  }
  res.render('login', { adminMode: true });
});

app.get('/admin/users', requireAdmin, (req, res) => {
  res.render('admin/users');
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = 200;

    const params = [];
    let whereSql = '';
    if (q) {
      params.push(`%${q}%`);
      whereSql = `WHERE u.username ILIKE $${params.length}`;
    }

    const result = await dbQuery(
      `
        SELECT
          u.id,
          u.username,
          u.contact,
          u.is_admin,
          u.created_at,
          COALESCE(e.cnt, 0) as entries_count,
          COALESCE(vc_assign.cnt, 0) as codes_assigned_count,
          COALESCE(vc_use.cnt, 0) as codes_used_count
        FROM users u
        LEFT JOIN (
          SELECT user_id, COUNT(*)::int as cnt
          FROM entries
          WHERE user_id IS NOT NULL
          GROUP BY user_id
        ) e ON e.user_id = u.id
        LEFT JOIN (
          SELECT assigned_user_id, COUNT(*)::int as cnt
          FROM verification_codes
          WHERE assigned_user_id IS NOT NULL
          GROUP BY assigned_user_id
        ) vc_assign ON vc_assign.assigned_user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(*)::int as cnt
          FROM verification_codes
          WHERE user_id IS NOT NULL
          GROUP BY user_id
        ) vc_use ON vc_use.user_id = u.id
        ${whereSql}
        ORDER BY u.created_at DESC
        LIMIT ${limit}
      `,
      params
    );

    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    const userId = parseInt(req.params.id);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!userId) {
      return res.status(400).json({ error: '用戶ID無效' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: '新密碼至少 6 個字' });
    }

    const hash = await bcrypt.hash(password, 10);
    const updated = await dbQuery('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id', [hash, userId]);
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: '會員不存在' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add item to raffle API
app.post('/api/admin/raffles/:id/items/add', requireAdmin, multerUnlessJson, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    const raffleId = parseInt(req.params.id);
    const { tier, name, description, image_url, total_count, is_final, pool_number } = req.body;

    if (!raffleId || !tier || !name || !total_count) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }

    const result = await dbQuery(`
      INSERT INTO prizes (raffle_id, tier, name, description, image_url, total_count, remaining_count, is_final, pool_number)
      VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)
      RETURNING id
    `, [
      raffleId,
      tier,
      name,
      description || '',
      image_url || null,
      parseInt(total_count, 10),
      is_final ? 1 : 0,
      pool_number || 1
    ]);

    res.json({ itemId: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Update item API
app.put('/api/admin/raffles/:raffleId/items/:itemId', requireAdmin, multerUnlessJson, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    const raffleId = parseInt(req.params.raffleId);
    const itemId = parseInt(req.params.itemId);
    const { tier, name, description, image_url, total_count, is_final, pool_number } = req.body;

    await dbQuery(`
      UPDATE prizes
      SET tier = $1, name = $2, description = $3, image_url = $4, total_count = $5, is_final = $6, pool_number = $7
      WHERE id = $8 AND raffle_id = $9
    `, [
      tier,
      name,
      description || '',
      image_url || null,
      parseInt(total_count, 10),
      is_final ? 1 : 0,
      pool_number || 1,
      itemId,
      raffleId
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Delete item API
app.delete('/api/admin/raffles/:raffleId/items/:itemId', requireAdmin, multerUnlessJson, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    const raffleId = parseInt(req.params.raffleId);
    const itemId = parseInt(req.params.itemId);

    await dbQuery('DELETE FROM prizes WHERE id = $1 AND raffle_id = $2', [itemId, raffleId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Change raffle status API
app.post('/api/admin/raffles/:id/status', requireAdmin, multerUnlessJson, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    const raffleId = parseInt(req.params.id);
    const { status } = req.body;

    await dbQuery('UPDATE raffles SET status = $1 WHERE id = $2', [status, raffleId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Reset all raffles, entries, codes, winners (dangerous - for admin use only)
app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }

    const { token, confirm } = req.body;
    const expectedToken = process.env.ADMIN_RESET_TOKEN;

    if (!expectedToken || token !== expectedToken) {
      return res.status(403).json({ error: 'Invalid reset token' });
    }

    if (confirm !== 'RESET') {
      return res.status(400).json({ error: 'Must confirm with RESET' });
    }

    // Delete in order of foreign keys
    await dbQuery('DELETE FROM winners');
    await dbQuery('DELETE FROM entries');
    await dbQuery('DELETE FROM verification_codes');
    await dbQuery('DELETE FROM prizes');
    await dbQuery('DELETE FROM raffles');
    
    // Do NOT delete users - keep admin account
    // await dbQuery('DELETE FROM users');

    res.json({ success: true, message: 'All raffles, prizes, codes, entries, winners deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Generate verification codes (admin only) - this is where we deduct stock immediately when generating
app.post('/api/admin/raffles/:id/generate-codes', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { count = 1, username } = req.body;
    const raffleId = parseInt(req.params.id);
    const numCount = parseInt(count);

    if (!req.session.user || !req.session.user.is_admin) {
      client.release();
      return res.status(403).json({ error: '需要管理員權限' });
    }

    if (!raffleId) {
      client.release();
      return res.status(400).json({ error: '抽獎活動ID無效' });
    }

    if (!numCount || numCount < 1) {
      client.release();
      return res.status(400).json({ error: '請輸入正確數量' });
    }
    if (numCount > 5000) {
      client.release();
      return res.status(400).json({ error: '一次最多生成 5000 個驗證碼' });
    }

    let assignedUserId = null;
    if (username && username.trim()) {
      const trimmedUsername = username.trim();
      const userResult = await dbQuery('SELECT id FROM users WHERE username = $1 LIMIT 1', [trimmedUsername], client);
      if (userResult.rows.length === 0) {
        client.release();
        return res.status(400).json({ error: '找不到此會員用戶名' });
      }
      assignedUserId = userResult.rows[0].id;
    }

    await client.query('BEGIN');

    // Get raffle and check available boxes
    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1', [raffleId], client);
    if (raffleResult.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: '抽獎活動不存在' });
    }
    const raffle = raffleResult.rows[0];

    if (raffle.status !== 'active') {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: '抽獎活動唔係活躍狀態' });
    }

    if (raffle.remaining_boxes < numCount) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ 
        error: `剩餘盒數不足。剩餘 ${raffle.remaining_boxes}，需要 ${numCount}` 
      });
    }

    // Get all available prizes with remaining_count > 0
    const availableResult = await dbQuery(
      `SELECT * FROM prizes WHERE raffle_id = $1 AND remaining_count > 0 ORDER BY is_final ASC`,
      [raffleId],
      client
    );
    let availablePrizes = availableResult.rows;

    if (availablePrizes.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: '冇剩餘獎品' });
    }

    const codes = [];
    let generatedCount = 0;

    // Generate N codes, each with pre-allocated prize - deduct immediately
    for (let i = 0; i < numCount; i++) {
      // Filter out prizes that still have count left after previous deductions in this batch
      availablePrizes = availablePrizes.filter(p => p.remaining_count > 0);
      
      if (availablePrizes.length === 0) {
        break;
      }

      // Weighted random pick based on remaining count
      const totalWeight = availablePrizes.reduce((sum, p) => sum + p.remaining_count, 0);
      const random = Math.floor(Math.random() * totalWeight);
      let acc = 0;
      let picked = null;

      for (const p of availablePrizes) {
        acc += p.remaining_count;
        if (random < acc) {
          picked = p;
          break;
        }
      }

      if (!picked) {
        picked = availablePrizes[availablePrizes.length - 1];
      }

      // Generate random 16-char code
      const code = crypto.randomBytes(8).toString('hex');

      // Insert the verification code with pre-allocated prize
      const insertResult = await dbQuery(
        `
          INSERT INTO verification_codes (raffle_id, code, prize_id, assigned_user_id, assigned_at, assigned_by)
          VALUES ($1, $2, $3, $4::INTEGER, CASE WHEN $4 IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, $5)
          RETURNING code
        `,
        [raffleId, code, picked.id, assignedUserId, req.session.user.id],
        client
      );

      if (insertResult.rows.length === 0) {
        // collision, skip
        continue;
      }

      // Decrement prize count immediately
      await dbQuery(
        `UPDATE prizes SET remaining_count = remaining_count - 1 WHERE id = $1`,
        [picked.id],
        client
      );

      picked.remaining_count--;
      codes.push(code);
      generatedCount++;
    }

    // Decrement raffle remaining boxes
    await dbQuery(
      `UPDATE raffles SET remaining_boxes = remaining_boxes - $1 WHERE id = $2`,
      [generatedCount, raffleId],
      client
    );

    const newRemaining = raffle.remaining_boxes - generatedCount;
    if (newRemaining <= 0) {
      await dbQuery(`UPDATE raffles SET status = 'completed' WHERE id = $1`, [raffleId], client);
    }

    await client.query('COMMIT');
    client.release();

    res.json({
      success: true,
      generated_count: generatedCount,
      remaining_boxes: newRemaining,
      codes: codes
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    console.error('Generate codes error:', err);
    const msg = err && err.message ? err.message : 'Unknown error';
    client.release();
    res.status(500).json({ error: `Server error: ${msg}` });
  }
});

// Get verification codes list for a raffle
app.get('/api/admin/raffles/:id/codes', requireAdmin, async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    const result = await dbQuery(`
      SELECT vc.*, au.username as assigned_username, uu.username as used_username
      FROM verification_codes vc
      LEFT JOIN users au ON vc.assigned_user_id = au.id
      LEFT JOIN users uu ON vc.user_id = uu.id
      WHERE vc.raffle_id = $1
      ORDER BY vc.created_at DESC
    `, [req.params.id]);
    
    res.json({ codes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Redeem an entry (for on-site redemption) - must come before GET /api/my/entries to avoid route matching conflict
app.post('/api/my/entries/:id/redeem', requireAuth, async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: '需要登入' });
    }
    const entryId = parseInt(req.params.id);
    const userId = req.session.user.id;
    
    // First ensure redeemed_at column exists (add if missing)
    try {
      await dbQuery('ALTER TABLE entries ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMP NULL');
    } catch (alterErr) {
      console.warn('ALTER TABLE entries warning (safe to ignore if column exists):', alterErr.message);
    }
    
    // Check that entry belongs to this user
    const checkResult = await dbQuery(
      'SELECT id, redeemed_at FROM entries WHERE id = $1 AND user_id = $2',
      [entryId, userId]
    );
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: '找不到此商品或不屬於你' });
    }
    
    const entry = checkResult.rows[0];
    if (entry.redeemed_at) {
      return res.status(400).json({ error: '此商品已經核銷過了' });
    }
    
    // Update redeemed_at
    await dbQuery(
      'UPDATE entries SET redeemed_at = CURRENT_TIMESTAMP WHERE id = $1',
      [entryId]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Get my entries (for logged in user)
app.get('/api/my/entries', requireAuth, async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: '需要登入' });
    }
    const userId = req.session.user.id;
    
    // Ensure redeemed_at column exists for all existing entries
    try {
      await dbQuery('ALTER TABLE entries ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMP NULL');
    } catch (alterErr) {
      console.warn('ALTER TABLE entries warning (safe to ignore if column exists):', alterErr.message);
    }
    
    const result = await dbQuery(`
      SELECT e.*, 
             r.title as raffle_title, 
             CASE WHEN p.tier IN ('A','B','C','D','E','F','G','H') THEN p.name ELSE '親筆簽名拍立得' END as prize_name,
             p.tier as prize_tier, 
             p.is_final as prize_is_final,
             vc.code as verification_code
      FROM entries e
      JOIN raffles r ON e.raffle_id = r.id
      LEFT JOIN prizes p ON e.prize_id = p.id
      LEFT JOIN verification_codes vc ON e.verification_code_id = vc.id
      WHERE e.user_id = $1
      ORDER BY e.drawn_at DESC
    `, [userId]);
    
    res.json({ entries: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login API
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '請填寫用戶名和密碼' });
    }
    
    const result = await dbQuery('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: '用戶名或密碼錯誤' });
    }
    
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: '用戶名或密碼錯誤' });
    }
    
    // Don't return password hash
    const { password_hash, ...userWithoutPassword } = user;
    req.session.user = userWithoutPassword;
    res.json({ 
      success: true, 
      user: userWithoutPassword 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Start server
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Ichiban Kuji Raffle Server running on port ${port}`);
    console.log(`- Public: http://localhost:${port}`);
    console.log(`- Admin: http://localhost:${port}/admin`);
    console.log(`- Using PostgreSQL: ${process.env.POSTGRES_URL ? 'Connected to Vercel Postgres' : 'Local database'}`);
  });
}

module.exports = app;