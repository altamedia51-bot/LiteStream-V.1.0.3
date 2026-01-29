
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

const initDB = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("PRAGMA foreign_keys = ON");

      // 1. Buat Tabel Plans
      db.run(`CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT UNIQUE, 
        max_storage_mb INTEGER, 
        allowed_types TEXT, 
        max_active_streams INTEGER,
        price_text TEXT,
        features_text TEXT,
        daily_limit_hours INTEGER DEFAULT 24
      )`);

      db.all("PRAGMA table_info(plans)", (err, columns) => {
        if (err || !columns) return;
        const hasPrice = columns.some(c => c.name === 'price_text');
        const hasFeatures = columns.some(c => c.name === 'features_text');
        const hasLimit = columns.some(c => c.name === 'daily_limit_hours');
        
        if (!hasPrice) db.run("ALTER TABLE plans ADD COLUMN price_text TEXT");
        if (!hasFeatures) db.run("ALTER TABLE plans ADD COLUMN features_text TEXT");
        if (!hasLimit) db.run("ALTER TABLE plans ADD COLUMN daily_limit_hours INTEGER DEFAULT 24");
      });

      // 2. Buat Tabel Users
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        username TEXT UNIQUE, 
        password_hash TEXT, 
        role TEXT DEFAULT 'user',
        plan_id INTEGER DEFAULT 1,
        storage_used INTEGER DEFAULT 0,
        usage_seconds INTEGER DEFAULT 0,
        last_usage_reset TEXT,
        FOREIGN KEY(plan_id) REFERENCES plans(id)
      )`);

      db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err || !columns) return;
        const hasUsage = columns.some(c => c.name === 'usage_seconds');
        const hasReset = columns.some(c => c.name === 'last_usage_reset');
        if (!hasUsage) db.run("ALTER TABLE users ADD COLUMN usage_seconds INTEGER DEFAULT 0");
        if (!hasReset) db.run("ALTER TABLE users ADD COLUMN last_usage_reset TEXT");
      });

      db.run(`CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, filename TEXT NOT NULL, path TEXT NOT NULL, size INTEGER, type TEXT DEFAULT 'video', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS stream_settings (key TEXT PRIMARY KEY, value TEXT)`);

      // 3. TABLE BARU: stream_destinations untuk Multi-Stream
      db.run(`CREATE TABLE IF NOT EXISTS stream_destinations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT,
        platform TEXT,
        rtmp_url TEXT,
        stream_key TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      )`);

      // 4. Seeding Data Plans
      const plans = [
        [1, 'Paket Free Trial', 500, 'audio', 1, 'Gratis', 'MP3 Only, Batasan 5 Jam/hari, Auto Reconnect', 5],
        [2, 'Paket Pro (Radio)', 5120, 'audio', 1, 'Rp 100.000', '24 Jam Non-stop, Kualitas HD, Custom Cover', 24],
        [3, 'Paket Station 24/7', 10240, 'audio', 1, 'Rp 150.000', 'Storage Besar, Shuffle Playlist, Visualizer', 24],
        [4, 'Paket Sultan (Private)', 25600, 'audio', 5, 'Rp 250.000', 'Dedicated VPS, Unlimited Platform, Setup Dibantu Full', 24]
      ];
      
      plans.forEach(p => {
        db.run(`INSERT OR IGNORE INTO plans (id, name, max_storage_mb, allowed_types, max_active_streams, price_text, features_text, daily_limit_hours) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, p);
        db.run(`UPDATE plans SET daily_limit_hours = ? WHERE id = ?`, [p[7], p[0]]);
      });

      // Seeding Default Settings
      const defaultSettings = [
        ['landing_title', 'Start Your <br> <span class="text-indigo-400">Radio Station.</span>'],
        ['landing_desc', 'Server streaming audio paling ringan. Upload MP3, pasang cover, dan broadcast 24/7.'],
        ['landing_btn_reg', 'Daftar Sekarang'],
        ['landing_btn_login', 'Login Member']
      ];
      defaultSettings.forEach(s => db.run(`INSERT OR IGNORE INTO stream_settings (key, value) VALUES (?, ?)`, s));

      // Seeding Admin
      const adminUser = 'admin';
      const adminPass = 'admin123';
      const hash = bcrypt.hashSync(adminPass, 10);
      
      db.get("SELECT id FROM users WHERE username = ?", [adminUser], (err, row) => {
        if (row) {
           db.run("UPDATE users SET password_hash = ?, role = 'admin', plan_id = 4 WHERE id = ?", [hash, row.id]);
        } else {
           db.run(`INSERT INTO users (username, password_hash, role, plan_id) VALUES (?, ?, 'admin', 4)`, [adminUser, hash]);
        }
        resolve();
      });
    });
  });
};

const getVideos = (userId) => new Promise((res, rej) => db.all("SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC", [userId], (err, rows) => err ? rej(err) : res(rows)));
const saveVideo = (data) => new Promise((res, rej) => db.run("INSERT INTO videos (user_id, filename, path, size, type) VALUES (?, ?, ?, ?, ?)", [data.user_id, data.filename, data.path, data.size, data.type || 'video'], function(err) { err ? rej(err) : res(this.lastID); }));
const deleteVideo = (id) => new Promise((res, rej) => db.run("DELETE FROM videos WHERE id = ?", [id], (err) => err ? rej(err) : res()));

module.exports = { initDB, getVideos, saveVideo, deleteVideo, db, dbPath };
