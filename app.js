const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

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
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Middleware
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Create tables if not exists
async function initDatabase() {
  try {
    await query(`
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

    // Check if we have any admin users, create default if none
    const adminResult = await query('SELECT COUNT(*) as count FROM users WHERE is_admin = 1');
    if (adminResult.rows[0].count === '0') {
      const defaultPassword = await bcrypt.hash('admin123', 10);
      await query(
        'INSERT INTO users (username, password_hash, contact, is_admin) VALUES ($1, $2, $3, $4)',
        ['admin', defaultPassword, 'admin@example.com', 1]
      );
      console.log('Default admin user created: admin / admin123');
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
  res.render('login');
});

// User register page
app.get('/register', (req, res) => {
  res.render('register');
});

// User my page - list my raffle entries
app.get('/my', async (req, res) => {
  // TODO: Add session auth
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
    const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: '用戶名已存在' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(`
      INSERT INTO users (username, password_hash, is_admin, contact)
      VALUES ($1, $2, 0, $3)
      RETURNING id
    `, [username, passwordHash, contact || null]);
    
    res.json({ success: true, userId: result.rows[0].id });
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
    const result = await query(`
      SELECT id, title, description, total_boxes, remaining_boxes, price_per_box, status
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
    const raffleResult = await query('SELECT * FROM raffles WHERE id = $1', [req.params.id]);
    if (raffleResult.rows.length === 0) {
      return res.status(404).send('抽獎活動不存在');
    }
    const raffle = raffleResult.rows[0];
    
    // Get all prizes grouped by tier
    const prizesResult = await query(`
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
    const winnersResult = await query(`
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
    const result = await query(`
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
    const result = await query(`
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
  try {
    const { name, contact, code, userId } = req.body;
    const raffleId = req.params.id;
    
    // Check verification code first
    if (!code) {
      return res.status(400).json({ error: '需要輸入抽獎驗證碼' });
    }
    
    const codeResult = await query(`
      SELECT * FROM verification_codes 
      WHERE code = $1 AND raffle_id = $2 AND used = false
    `, [code, raffleId]);
    
    if (codeResult.rows.length === 0) {
      return res.status(400).json({ error: '驗證碼無效或已使用' });
    }
    
    const verificationCode = codeResult.rows[0];
    
    // Check raffle is active and has remaining boxes
    const raffleResult = await query('SELECT * FROM raffles WHERE id = $1', [raffleId]);
    if (raffleResult.rows.length === 0) {
      return res.status(400).json({ error: '抽獎活動不存在' });
    }
    const raffle = raffleResult.rows[0];
    
    if (raffle.status !== 'active') {
      return res.status(400).json({ error: '抽獎活動已關閉' });
    }
    if (raffle.remaining_boxes <= 0) {
      return res.status(400).json({ error: '所有盒子已經抽完' });
    }
    
    // Get all prizes that still have remaining count
    const availableResult = await query(`
      SELECT * FROM prizes
      WHERE raffle_id = $1 AND remaining_count > 0
      ORDER BY is_final ASC
    `, [raffleId]);
    const availablePrizes = availableResult.rows;
    
    if (availablePrizes.length === 0) {
      return res.status(400).json({ error: '沒有剩餘獎品了' });
    }
    
    // Weighted random selection based on remaining count
    const weighted = [];
    for (const prize of availablePrizes) {
      for (let i = 0; i < prize.remaining_count; i++) {
        weighted.push(prize);
      }
    }
    
    const randomIndex = Math.floor(Math.random() * weighted.length);
    const drawnPrize = weighted[randomIndex];
    
    // Start transaction - use sequential queries
    await query('BEGIN');
    
    try {
      // Decrease remaining count for the prize
      await query(`
        UPDATE prizes 
        SET remaining_count = remaining_count - 1 
        WHERE id = $1
      `, [drawnPrize.id]);
      
      // Decrease remaining boxes for the raffle
      await query(`
        UPDATE raffles 
        SET remaining_boxes = remaining_boxes - 1 
        WHERE id = $1
      `, [raffleId]);
      
      // If no boxes left, mark raffle as completed
      if (raffle.remaining_boxes - 1 <= 0) {
        await query(`
          UPDATE raffles 
          SET status = 'completed' 
          WHERE id = $1
        `, [raffleId]);
      }
      
      // Create entry
      const entryResult = await query(`
        INSERT INTO entries (raffle_id, prize_id, buyer_name, buyer_contact, user_id, verification_code_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [raffleId, drawnPrize.id, name, contact, userId || null, verificationCode.id]);
      const entryId = entryResult.rows[0].id;
      
      // Mark verification code as used
      await query(`
        UPDATE verification_codes 
        SET used = true, used_at = CURRENT_TIMESTAMP, user_id = $1 
        WHERE id = $2
      `, [userId || null, verificationCode.id]);
      
      // Record winner
      await query(`
        INSERT INTO winners (entry_id, raffle_id, prize_id, buyer_name, user_id)
        VALUES ($1, $2, $3, $4, $5)
      `, [entryId, raffleId, drawnPrize.id, name, userId || null]);
      
      await query('COMMIT');
      
      // Get updated prize info
      const updatedResult = await query('SELECT * FROM prizes WHERE id = $1', [drawnPrize.id]);
      const updatedPrize = updatedResult.rows[0];
      
      res.json({
        success: true,
        entryId,
        prize: {
          id: updatedPrize.id,
          name: updatedPrize.name,
          tier: updatedPrize.tier,
          description: updatedPrize.description,
          image_url: updatedPrize.image_url,
          is_final: updatedPrize.is_final
        },
        remaining_boxes: raffle.remaining_boxes - 1
      });
    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ===== Admin Routes =====

// Admin dashboard
app.get('/admin', async (req, res) => {
  try {
    const result = await query(`
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
app.get('/admin/create', (req, res) => {
  res.render('admin/create');
});

// Create raffle API
app.post('/api/admin/raffles/create', async (req, res) => {
  try {
    const { 
      title, 
      description, 
      total_boxes, 
      price_per_box, 
      num_pools,
      start_date,
      end_date 
    } = req.body;
    
    const result = await query(`
      INSERT INTO raffles (
        title, description, type, total_boxes, price_per_box, 
        remaining_boxes, num_pools, start_date, end_date, status
      ) VALUES ($1, $2, 'ichiban', $3, $4, $5, $6, $7, $8, 'active')
      RETURNING id
    `, [
      title, 
      description, 
      parseInt(total_boxes), 
      parseFloat(price_per_box), 
      parseInt(total_boxes), 
      parseInt(num_pools || 1),
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
    
    const result = await query(`
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
      parseInt(total_count),
      parseInt(total_count),
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
    const raffleResult = await query('SELECT * FROM raffles WHERE id = $1', [req.params.id]);
    const prizesResult = await query('SELECT * FROM prizes WHERE raffle_id = $1 ORDER BY pool_number, is_final DESC, tier', [req.params.id]);
    
    res.json({ raffle: raffleResult.rows[0], prizes: prizesResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete prize
app.delete('/api/admin/raffles/:raffleId/prizes/:prizeId', async (req, res) => {
  try {
    await query('DELETE FROM prizes WHERE id = $1 AND raffle_id = $2', [
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
    await query('UPDATE raffles SET status = $1 WHERE id = $2', [status, req.params.id]);
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate verification codes (admin only)
app.post('/api/admin/raffles/:id/generate-codes', async (req, res) => {
  try {
    const { count } = req.body;
    const raffleId = parseInt(req.params.id);
    const numCount = parseInt(count);
    
    if (!numCount || numCount < 1) {
      return res.status(400).json({ error: '請輸入正確數量' });
    }
    
    const codes = [];
    // Generate random 8-character codes
    for (let i = 0; i < numCount; i++) {
      const code = Math.random().toString(36).substring(2, 10);
      await query(`
        INSERT INTO verification_codes (raffle_id, code)
        VALUES ($1, $2)
      `, [raffleId, code]);
      codes.push(code);
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
    const result = await query(`
      SELECT * FROM verification_codes
      WHERE raffle_id = $1
      ORDER BY created_at DESC
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
    // TODO: Add actual auth, for now just query by user_id
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: '需要用戶ID' });
    }
    
    const result = await query(`
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
    
    const result = await query('SELECT * FROM users WHERE username = $1', [username]);
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
    res.json({ 
      success: true, 
      user: userWithoutPassword 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Ichiban Kuji Raffle Server running on port ${port}`);
  console.log(`- Public: http://localhost:${port}`);
  console.log(`- Admin: http://localhost:${port}/admin`);
  console.log(`- Default admin: admin / admin123`);
  console.log(`- Using PostgreSQL: ${process.env.POSTGRES_URL ? 'Connected to Vercel Postgres' : 'Local database'}`);
});

module.exports = app;
