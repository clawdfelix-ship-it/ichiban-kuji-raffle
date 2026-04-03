const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Database setup
const db = new Database('./raffle.db');

// Create tables if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS raffles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    description TEXT,
    type TEXT DEFAULT 'single', -- 'single' = 傳統抽獎( one prize, many entrants ), 'ichiban' = 一番賞( multiple prizes, one entry = one prize )
    total_boxes INTEGER, -- 總盒數 (一番賞)
    remaining_boxes INTEGER, -- 剩餘盒數
    start_date DATETIME,
    end_date DATETIME,
    status TEXT DEFAULT 'active',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    drawn_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS prizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    tier TEXT, -- A B C D 獎級
    name TEXT, -- 獎品名稱
    total_count INTEGER, -- 總數
    remaining_count INTEGER, -- 剩餘數
    is_final BOOLEAN DEFAULT 0, -- 是否最終賞
    pool_number INTEGER NULL, -- 獎池編號(最終賞分池)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(raffle_id) REFERENCES raffles(id)
  );

  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    name TEXT,
    contact TEXT,
    won_prize_id INTEGER NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(raffle_id) REFERENCES raffles(id),
    FOREIGN KEY(won_prize_id) REFERENCES prizes(id)
  );

  CREATE TABLE IF NOT EXISTS winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raffle_id INTEGER,
    entry_id INTEGER,
    prize_id INTEGER,
    drawn_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(raffle_id) REFERENCES raffles(id),
    FOREIGN KEY(entry_id) REFERENCES entries(id),
    FOREIGN KEY(prize_id) REFERENCES prizes(id)
  );
);

// Create default admin if not exists
const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1').get().count;
if (adminCount === 0) {
  const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
  const passwordHash = bcrypt.hashSync(defaultPassword, 10);
  db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run('admin', passwordHash, 1);
  console.log('Created default admin user: admin / ' + defaultPassword);
  console.log('⚠️  Change this password in production!');
}

// Auth middleware
function requireAdmin(req, res, next) {
  // Simple session-free auth for admin - uses password query param or form
  // In production you'd want proper sessions, this is simple
  const adminPassword = req.body.admin_password || req.query.admin_password;
  if (!adminPassword) {
    return res.status(401).json({ error: 'Admin password required' });
  }
  const admin = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  if (!admin || !bcrypt.compareSync(adminPassword, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  req.admin = admin;
  next();
}

// API Routes

// Get all active raffles
app.get('/api/raffles', (req, res) => {
  const raffles = db.prepare(`
    SELECT id, title, description, type, total_boxes, remaining_boxes, start_date, end_date 
    FROM raffles 
    WHERE status = 'active'
    ORDER BY created_at DESC
  `).all();
  
  // Add prize stats for ichiban
  const result = raffles.map(r => {
    if (r.type !== 'ichiban') {
      return r;
    }
    const prizeStats = db.prepare(`
      SELECT tier, COUNT(*) as total, SUM(remaining_count) as remaining 
      FROM prizes 
      WHERE raffle_id = ? 
      GROUP BY tier
      ORDER BY tier
    `).all(r.id);
    return {
      ...r,
      prize_stats: prizeStats
    };
  });
  
  res.json({ raffles: result });
});

// Get single raffle
app.get('/api/raffles/:id', (req, res) => {
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(req.params.id);
  if (!raffle) {
    return res.status(404).json({ error: 'Raffle not found' });
  }
  
  const entryCount = db.prepare('SELECT COUNT(*) as count FROM entries WHERE raffle_id = ?').get(req.params.id).count;
  
  res.json({ 
    raffle, 
    entry_count: entryCount,
    is_closed: raffle.status !== 'active'
  });
});

// Enter raffle / draw for ichiban
app.post('/api/raffles/:id/enter', (req, res) => {
  const { name, contact } = req.body;
  const raffleId = req.params.id;
  
  if (!name || !contact) {
    return res.status(400).json({ error: 'Name and contact are required' });
  }
  
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
  if (!raffle) {
    return res.status(404).json({ error: 'Raffle not found' });
  }
  
  if (raffle.status !== 'active') {
    return res.status(400).json({ error: 'This raffle is closed' });
  }

  // Traditional single prize raffle
  if (raffle.type !== 'ichiban') {
    const info = db.prepare('INSERT INTO entries (raffle_id, name, contact) VALUES (?, ?, ?)').run(raffleId, name, contact);
    return res.json({ success: true, entry_id: info.lastInsertRowid });
  }

  // Ichiban Kuji raffle - draw a prize immediately
  if (raffle.remaining_boxes <= 0) {
    return res.status(400).json({ error: 'All boxes are sold out' });
  }

  // Get all available prizes (remaining_count > 0)
  const availablePrizes = db.prepare(`
    SELECT * FROM prizes 
    WHERE raffle_id = ? AND remaining_count > 0
    ORDER BY RANDOM()
  `).all(raffleId);

  if (availablePrizes.length === 0) {
    return res.status(400).json({ error: 'No prizes left' });
  }

  // Pick a random prize - weighted random by remaining count
  // More remaining = higher chance (correct for ichiban kuji)
  const totalWeight = availablePrizes.reduce((sum, p) => sum + p.remaining_count, 0);
  let random = Math.floor(Math.random() * totalWeight);
  let picked = null;

  for (const prize of availablePrizes) {
    random -= prize.remaining_count;
    if (random <= 0) {
      picked = prize;
      break;
    }
  }

  if (!picked) {
    picked = availablePrizes[availablePrizes.length - 1];
  }

  // Insert entry with prize
  const info = db.prepare('INSERT INTO entries (raffle_id, name, contact, won_prize_id) VALUES (?, ?, ?, ?)').run(
    raffleId, name, contact, picked.id
  );

  // Decrement remaining count
  db.prepare('UPDATE prizes SET remaining_count = remaining_count - 1 WHERE id = ?').run(picked.id);

  // Decrement remaining boxes
  db.prepare('UPDATE raffles SET remaining_boxes = remaining_boxes - 1 WHERE id = ?').run(raffleId);

  // Check if all boxes gone - close raffle
  const newRemaining = raffle.remaining_boxes - 1;
  if (newRemaining <= 0) {
    db.prepare('UPDATE raffles SET status = "completed" WHERE id = ?').run(raffleId);
  }

  // Get final prize info for response
  const wonPrize = {
    id: picked.id,
    tier: picked.tier,
    name: picked.name,
    is_final: picked.is_final,
    pool_number: picked.pool_number
  };

  res.json({ 
    success: true, 
    entry_id: info.lastInsertRowid,
    prize: wonPrize,
    remaining_boxes: newRemaining
  });
});

// Get raffle results
app.get('/api/raffles/:id/results', (req, res) => {
  const raffleId = req.params.id;
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
  
  if (!raffle) {
    return res.status(404).json({ error: 'Raffle not found' });
  }
  
  if (raffle.status === 'active') {
    return res.status(400).json({ error: 'Results not available yet' });
  }
  
  const winners = db.prepare(`
    SELECT w.id, e.name, e.contact, w.prize, w.drawn_at
    FROM winners w
    JOIN entries e ON w.entry_id = e.id
    WHERE w.raffle_id = ?
    ORDER BY w.id
  `).all(raffleId);
  
  const totalEntries = db.prepare('SELECT COUNT(*) as count FROM entries WHERE raffle_id = ?').get(raffleId).count;
  
  res.json({
    raffle,
    winners,
    total_entries: totalEntries
  });
});

// Admin: get all raffles
app.get('/api/admin/raffles', requireAdmin, (req, res) => {
  const raffles = db.prepare(`
    SELECT id, title, description, prize, status, start_date, end_date, created_at
    FROM raffles 
    ORDER BY created_at DESC
  `).all();
  
  const stats = raffles.map(r => {
    const count = db.prepare('SELECT COUNT(*) as count FROM entries WHERE raffle_id = ?').get(r.id).count;
    return { ...r, entry_count: count };
  });
  
  res.json({ raffles: stats });
});

// Admin: create raffle
app.post('/api/admin/raffles/create', requireAdmin, (req, res) => {
  const { title, description, type = 'single', total_boxes, prizes } = req.body;
  
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  if (type === 'single') {
    const { prize, start_date, end_date } = req.body;
    if (!prize || !end_date) {
      return res.status(400).json({ error: 'Prize and end date are required' });
    }
  
    const info = db.prepare(`
      INSERT INTO raffles (title, description, type, prize, total_boxes, start_date, end_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, description, type, prize, total_boxes, start_date, end_date, req.admin.id);
    
    return res.json({ success: true, id: info.lastInsertRowid });
  }

  // Ichiban Kuji creation
  if (type === 'ichiban') {
    if (!total_boxes || !prizes || !Array.isArray(prizes) || prizes.length === 0) {
      return res.status(400).json({ error: 'Total boxes and prizes array are required' });
    }

    // Insert raffle
    const info = db.prepare(`
      INSERT INTO raffles (title, description, type, total_boxes, remaining_boxes, start_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, description, type, total_boxes, total_boxes, new Date().toISOString(), req.admin.id);

    const raffleId = info.lastInsertid;

    // Insert all prizes
    const insertPrize = db.prepare(`
      INSERT INTO prizes (raffle_id, tier, name, total_count, remaining_count, is_final, pool_number)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const prize of prizes) {
      insertPrize.run(
        raffleId, 
        prize.tier || 'A', 
        prize.name, 
        prize.count, 
        prize.count, 
        prize.is_final ? 1 : 0,
        prize.pool_number || null
      );
    }

    return res.json({ 
      success: true, 
      id: raffleId,
      total_boxes,
      total_prizes: prizes.length
    });
  }
});

// Admin: draw winners
app.post('/api/admin/raffles/:id/draw', requireAdmin, (req, res) => {
  const { number_of_winners = 1 } = req.body;
  const raffleId = req.params.id;
  
  const raffle = db.prepare('SELECT * FROM raffles WHERE id = ?').get(raffleId);
  if (!raffle) {
    return res.status(404).json({ error: 'Raffle not found' });
  }
  
  const entries = db.prepare('SELECT * FROM entries WHERE raffle_id = ?').all(raffleId);
  if (entries.length === 0) {
    return res.status(400).json({ error: 'No entries to draw from' });
  }
  
  // Shuffle and pick winners (Fisher-Yates shuffle)
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  const winners = shuffled.slice(0, Math.min(number_of_winners, shuffled.length));
  
  // Save winners
  const insertWinner = db.prepare('INSERT INTO winners (raffle_id, entry_id, prize) VALUES (?, ?, ?)');
  for (const winner of winners) {
    insertWinner.run(raffleId, winner.id, raffle.prize);
  }
  
  // Mark raffle as drawn
  db.prepare('UPDATE raffles SET status = "completed", drawn_at = CURRENT_TIMESTAMP WHERE id = ?').run(raffleId);
  
  res.json({
    success: true,
    winners: winners.map(w => ({ id: w.id, name: w.name }))
  });
});

// Start server
app.listen(port, () => {
  console.log(`🎫 Raffle website running on http://localhost:${port}`);
  console.log(`🔐 Admin default: /public/admin.html - user: admin / password: ${process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'}`);
});
