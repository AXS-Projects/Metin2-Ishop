const express = require('express');
const session = require('express-session');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const middleware = require('i18next-express-middleware');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3');
const { promisify } = require('util');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const mysql = require('mysql2/promise');

const app = express();

// i18n configuration
i18next
  .use(Backend)
  .use(middleware.LanguageDetector)
  .init({
    fallbackLng: 'en',
    backend: {
      loadPath: path.join(__dirname, 'locales/{{lng}}/translation.json')
    }
  });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(middleware.handle(i18next));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ishop-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
}));

const mysqlPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
  database: process.env.DB_NAME || undefined,
  waitForConnections: true,
  connectionLimit: 10
});

const dbFile = path.join(__dirname, 'data/items.db');
const db = new sqlite3.Database(dbFile);
db.run('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT, price REAL)');
db.get('SELECT COUNT(*) as cnt FROM items', (err, row) => {
  if (!err && row && row.cnt === 0) {
    const jsonFile = path.join(__dirname, 'data/items.json');
    if (fs.existsSync(jsonFile)) {
      const initial = JSON.parse(fs.readFileSync(jsonFile));
      initial.forEach(it => db.run('INSERT INTO items(id,name,price) VALUES(?,?,?)', [it.id, it.name, it.price]));
    }
  }
});
const dbAll = promisify(db.all.bind(db));
function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
const dbGet = promisify(db.get.bind(db));

async function loadItems() {
  return dbAll('SELECT id, name, price FROM items');
}
async function getItem(id) {
  return dbGet('SELECT id, name, price FROM items WHERE id = ?', [id]);
}
async function addItem(item) {
  return dbRun('INSERT INTO items(id, name, price) VALUES (?, ?, ?)', [item.id, item.name, item.price]);
}
async function updateItem(item) {
  return dbRun('UPDATE items SET name=?, price=? WHERE id=?', [item.name, item.price, item.id]);
}
async function deleteItem(id) {
  return dbRun('DELETE FROM items WHERE id=?', [id]);
}

async function authenticateUser(username, password) {
  const [rows] = await mysqlPool.query('SELECT id, password FROM account.account WHERE login=?', [username]);
  if (!rows.length) return null;
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(password).digest('hex');
  if (rows[0].password.toLowerCase() !== hash.toLowerCase()) return null;
  return { id: rows[0].id, username };
}

async function addItemToAccount(accountId, itemVnum) {
  const [chars] = await mysqlPool.query('SELECT id FROM player.player WHERE account_id=? LIMIT 1', [accountId]);
  if (!chars.length) return;
  const charId = chars[0].id;
  await mysqlPool.query('INSERT INTO player.item(owner_id, window, pos, count, vnum) VALUES (?, "MALL", 0, 1, ?)', [charId, itemVnum]);
}

app.get('/', async (req, res) => {
  const items = await loadItems();
  res.render('index', { items, t: req.t, query: req.query, session: req.session });
});

app.get('/lang/:lng', (req, res) => {
  res.cookie('i18next', req.params.lng);
  res.redirect('back');
});

app.get('/buy/:id', async (req, res) => {
  if (!req.session.accountId) return res.redirect('/login');
  const item = await getItem(req.params.id);
  if (!item) return res.redirect('/');
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{ price_data: { currency: 'usd', product_data: { name: item.name }, unit_amount: item.price * 100 }, quantity: 1 }],
      success_url: req.protocol + '://' + req.get('host') + '/success/' + item.id,
      cancel_url: req.protocol + '://' + req.get('host') + '/?canceled=true'
    });
    res.redirect(session.url);
  } catch (err) {
    res.status(500).send('Payment error');
  }
});

app.get('/success/:id', async (req, res) => {
  if (!req.session.accountId) return res.redirect('/login');
  const item = await getItem(req.params.id);
  if (item) {
    try { await addItemToAccount(req.session.accountId, item.id); } catch (e) {}
  }
  res.redirect('/?success=true');
});

app.get('/login', (req, res) => {
  res.render('user_login', { t: req.t });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await authenticateUser(username, password);
  if (!user) {
    return res.render('user_login', { error: req.t('invalid_credentials'), t: req.t });
  }
  req.session.accountId = user.id;
  req.session.username = user.username;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Admin routes
app.get('/admin', async (req, res) => {
  if (!req.session.authenticated) {
    return res.render('login', { t: req.t });
  }
  const items = await loadItems();
  res.render('admin', { items, t: req.t });
});

app.post('/admin/login', async (req, res) => {
  const { password } = req.body;
  const hash = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin', 10);
  if (await bcrypt.compare(password, hash)) {
    req.session.authenticated = true;
    res.redirect('/admin');
  } else {
    res.render('login', { error: req.t('invalid_password'), t: req.t });
  }
});

app.post('/admin/add', async (req, res) => {
  if (!req.session.authenticated) return res.redirect('/admin');
  const { id, name, price } = req.body;
  const existing = await getItem(id);
  if (existing) {
    const items = await loadItems();
    return res.render('admin', { items, error: req.t('item_exists'), t: req.t });
  }
  await addItem({ id, name, price: parseFloat(price) });
  res.redirect('/admin');
});

app.post('/admin/edit/:id', async (req, res) => {
  if (!req.session.authenticated) return res.redirect('/admin');
  const { name, price } = req.body;
  await updateItem({ id: req.params.id, name, price: parseFloat(price) });
  res.redirect('/admin');
});

app.post('/admin/delete/:id', async (req, res) => {
  if (!req.session.authenticated) return res.redirect('/admin');
  await deleteItem(req.params.id);
  res.redirect('/admin');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
