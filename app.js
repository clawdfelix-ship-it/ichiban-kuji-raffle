const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection - supports Vercel Postgres
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('ERROR: POSTGRES_URL environment variable is not set!');
  console.error('Please go to Vercel dashboard → Project → Settings → Environment Variables');
  console.error('Add POSTGRES_URL from your Vercel Postgres connection string');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: false } : false
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024
  }
});

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

// Middleware
const path = require('path');
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
  throw new Error('SESSION_SECRET is required on Vercel. Please set it in Vercel Environment Variables.');
}

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set. Using a random secret (sessions will reset on restart).');
}

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
        used BOOLEAN DEFAULT FALSE,
        used_at TIMESTAMP NULL,
        user_id INTEGER NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(raffle_id) REFERENCES raffles(id)
      );
    `);

    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_user_id INTEGER NULL');
    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP NULL');
    await dbQuery('ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS assigned_by INTEGER NULL');
    await dbQuery('ALTER TABLE raffles ADD COLUMN IF NOT EXISTS cover_image TEXT NULL');

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
  }
}

initDatabase();

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
app.get('/my', async (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
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
      INSERT INTO users (username, password_hash, is_admin, contact)
      VALUES ($1, $2, 0, $3)
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
      SELECT w.*, p.name as prize_name, p.tier as prize_tier
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
      SELECT w.*, p.name as prize_name, p.tier as prize_tier
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
      return res.status(400).json({ error: '抽獎活動ID無效' });
    }
    if (!code) {
      return res.status(400).json({ error: '需要輸入抽獎驗證碼' });
    }
    if (!username || !contact) {
      return res.status(400).json({ error: '需要填寫會員用戶名和聯絡方式' });
    }

    await client.query('BEGIN');

    const codeResult = await dbQuery(
      `
        SELECT * FROM verification_codes
        WHERE code = $1 AND raffle_id = $2 AND used = false
        FOR UPDATE
      `,
      [code, raffleId],
      client
    );
    if (codeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '驗證碼無效或已使用' });
    }
    const verificationCode = codeResult.rows[0];

    if (verificationCode.assigned_user_id) {
      if (!req.session.user) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: '此驗證碼已分配給會員，請登入後再抽獎' });
      }
      if (Number(req.session.user.id) !== Number(verificationCode.assigned_user_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: '此驗證碼已分配給其他會員' });
      }
    }

    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1 FOR UPDATE', [raffleId], client);
    if (raffleResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '抽獎活動不存在' });
    }
    const raffle = raffleResult.rows[0];

    if (raffle.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '抽獎活動已關閉' });
    }
    if (raffle.remaining_boxes <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '所有盒子已經抽完' });
    }

    const availableResult = await dbQuery(
      `
        SELECT * FROM prizes
        WHERE raffle_id = $1 AND remaining_count > 0
        ORDER BY is_final ASC
        FOR UPDATE
      `,
      [raffleId],
      client
    );
    const availablePrizes = availableResult.rows;
    if (availablePrizes.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '沒有剩餘獎品了' });
    }

    let total = 0;
    for (const p of availablePrizes) total += Number(p.remaining_count || 0);
    if (total <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '沒有剩餘獎品了' });
    }

    const roll = crypto.randomInt(0, total);
    let acc = 0;
    let drawnPrize = availablePrizes[0];
    for (const p of availablePrizes) {
      acc += Number(p.remaining_count);
      if (roll < acc) {
        drawnPrize = p;
        break;
      }
    }

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
    if (prizeUpdate.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '獎品餘量更新失敗，請重試' });
    }
    const updatedPrize = prizeUpdate.rows[0];

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
    if (raffleUpdate.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: '盒子餘量更新失敗，請重試' });
    }
    const remainingBoxes = raffleUpdate.rows[0].remaining_boxes;
    if (remainingBoxes <= 0) {
      await dbQuery(`UPDATE raffles SET status = 'completed' WHERE id = $1`, [raffleId], client);
    }

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
      return res.status(409).json({ error: '驗證碼已被使用，請檢查後重試' });
    }

    const entryResult = await dbQuery(
      `
        INSERT INTO entries (raffle_id, prize_id, buyer_name, buyer_contact, user_id, verification_code_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `,
      [raffleId, updatedPrize.id, username, contact, userId, verificationCode.id],
      client
    );
    const entryId = entryResult.rows[0].id;

    await dbQuery(
      `
        INSERT INTO winners (entry_id, raffle_id, prize_id, buyer_name, user_id)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [entryId, raffleId, updatedPrize.id, username, userId],
      client
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      entryId,
      prize: updatedPrize,
      remaining_boxes: remainingBoxes
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== Admin Routes =====

// Admin dashboard
app.get('/admin', async (req, res) => {
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

// Create raffle API
app.post('/api/admin/raffles/create', upload.single('cover_image'), async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    const { 
      title, 
      description, 
      total_boxes, 
      price_per_box, 
      num_pools,
      start_date,
      end_date 
    } = req.body;

    let coverImage = null;
    if (req.file) {
      const isImage = typeof req.file.mimetype === 'string' && req.file.mimetype.startsWith('image/');
      if (!isImage) {
        return res.status(400).json({ error: '封面必須是圖片檔案' });
      }
      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      coverImage = dataUri;
    }
    
    const parsedTotalBoxes = parseInt(total_boxes);
    const parsedPrice = parseFloat(price_per_box);
    const parsedPools = parseInt(num_pools || 1);

    if (!title || !parsedTotalBoxes || parsedTotalBoxes < 1 || !parsedPrice || parsedPrice < 0) {
      return res.status(400).json({ error: '請填寫正確抽獎資料' });
    }
    if (!parsedPools || parsedPools < 1 || parsedPools > 50) {
      return res.status(400).json({ error: 'Pool 數量不正確' });
    }

    const result = await dbQuery(`
      INSERT INTO raffles (
        title, description, type, total_boxes, price_per_box, cover_image,
        remaining_boxes, num_pools, start_date, end_date, status
      ) VALUES ($1, $2, 'ichiban', $3, $4, $5, $6, $7, $8, $9, 'active')
      RETURNING id
    `, [
      title, 
      description, 
      parsedTotalBoxes,
      parsedPrice,
      coverImage,
      parsedTotalBoxes,
      parsedPools,
      start_date || null,
      end_date || null
    ]);
    
    res.json({ 
      success: true, 
      raffleId: result.rows[0].id 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add prize to raffle
app.post('/api/admin/raffles/:id/prizes/add', async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    const { 
      tier, 
      name, 
      description, 
      image_url, 
      total_count,
      is_final,
      pool_number 
    } = req.body;
    
    const raffleId = req.params.id;
    
    const parsedTotal = parseInt(total_count);
    if (!name || !parsedTotal || parsedTotal < 1) {
      return res.status(400).json({ error: '請填寫正確獎品資料' });
    }

    const result = await dbQuery(`
      INSERT INTO prizes (
        raffle_id, tier, name, description, image_url, 
        total_count, remaining_count, is_final, pool_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      parseInt(raffleId),
      tier,
      name,
      description || null,
      image_url || null,
      parsedTotal,
      parsedTotal,
      is_final ? 't' : 'f',
      is_final ? (parseInt(pool_number) || 1) : null
    ]);
    
    res.json({ 
      success: true, 
      prizeId: result.rows[0].id 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get raffle with prizes for admin editing
app.get('/api/admin/raffles/:id', async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    const raffleResult = await dbQuery('SELECT * FROM raffles WHERE id = $1', [req.params.id]);
    const prizesResult = await dbQuery('SELECT * FROM prizes WHERE raffle_id = $1 ORDER BY pool_number, is_final DESC, tier', [req.params.id]);
    
    res.json({ raffle: raffleResult.rows[0], prizes: prizesResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete prize
app.delete('/api/admin/raffles/:raffleId/prizes/:prizeId', async (req, res) => {
  try {
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    await dbQuery('DELETE FROM prizes WHERE id = $1 AND raffle_id = $2', [
      req.params.prizeId, 
      req.params.raffleId
    ]);
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Close/reopen raffle
app.post('/api/admin/raffles/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    if (!['active', 'closed', 'completed'].includes(status)) {
      return res.status(400).json({ error: '狀態不正確' });
    }
    await dbQuery('UPDATE raffles SET status = $1 WHERE id = $2', [status, req.params.id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate verification codes (admin only)
app.post('/api/admin/raffles/:id/generate-codes', async (req, res) => {
  try {
    const { count, username } = req.body;
    const raffleId = parseInt(req.params.id);
    const numCount = parseInt(count);
    const trimmedUsername = typeof username === 'string' ? username.trim() : '';

    if (!req.session.user || !req.session.user.is_admin) {
      return res.status(403).json({ error: '需要管理員權限' });
    }
    
    if (!numCount || numCount < 1) {
      return res.status(400).json({ error: '請輸入正確數量' });
    }
    if (numCount > 5000) {
      return res.status(400).json({ error: '一次最多生成 5000 個驗證碼' });
    }

    let assignedUserId = null;
    if (trimmedUsername) {
      const userResult = await dbQuery('SELECT id FROM users WHERE username = $1 LIMIT 1', [trimmedUsername]);
      if (userResult.rows.length === 0) {
        return res.status(400).json({ error: '找不到此會員用戶名' });
      }
      assignedUserId = userResult.rows[0].id;
    }
    
    const codes = [];
    while (codes.length < numCount) {
      const code = crypto.randomBytes(6).toString('hex');
      const inserted = await dbQuery(
        `
          INSERT INTO verification_codes (raffle_id, code, assigned_user_id, assigned_at, assigned_by)
          VALUES ($1, $2, $3, CASE WHEN $3 IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, $4)
          ON CONFLICT (code) DO NOTHING
          RETURNING code
        `,
        [raffleId, code, assignedUserId, req.session.user.id]
      );
      if (inserted.rows.length > 0) {
        codes.push(inserted.rows[0].code);
      }
    }
    
    res.json({ 
      success: true, 
      codes: codes,
      count: codes.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get verification codes list for a raffle
app.get('/api/admin/raffles/:id/codes', async (req, res) => {
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

// Get my entries (for logged in user)
app.get('/api/my/entries', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: '需要登入' });
    }
    const userId = req.session.user.id;
    
    const result = await dbQuery(`
      SELECT e.*, r.title as raffle_title, p.name as prize_name, p.tier as prize_tier, p.is_final as prize_is_final
      FROM entries e
      JOIN raffles r ON e.raffle_id = r.id
      LEFT JOIN prizes p ON e.prize_id = p.id
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
