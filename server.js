const express = require('express');
const session = require('express-session');
const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const middleware = require('i18next-express-middleware');
const fs = require('fs');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

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
app.use(session({ secret: 'ishop-secret', resave: false, saveUninitialized: false }));

const itemsFile = path.join(__dirname, 'data/items.json');
function loadItems() {
  if (!fs.existsSync(itemsFile)) {
    fs.writeFileSync(itemsFile, JSON.stringify([]));
  }
  return JSON.parse(fs.readFileSync(itemsFile));
}
function saveItems(items) {
  fs.writeFileSync(itemsFile, JSON.stringify(items, null, 2));
}

app.get('/', (req, res) => {
  const items = loadItems();
  res.render('index', { items, t: req.t, query: req.query });
});

app.get('/lang/:lng', (req, res) => {
  res.cookie('i18next', req.params.lng);
  res.redirect('back');
});

app.get('/buy/:id', async (req, res) => {
  const items = loadItems();
  const item = items.find(i => i.id === req.params.id);
  if (!item) return res.redirect('/');
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{ price_data: { currency: 'usd', product_data: { name: item.name }, unit_amount: item.price * 100 }, quantity: 1 }],
      success_url: req.protocol + '://' + req.get('host') + '/?success=true',
      cancel_url: req.protocol + '://' + req.get('host') + '/?canceled=true'
    });
    res.redirect(session.url);
  } catch (err) {
    res.status(500).send('Payment error');
  }
});

// Admin routes
app.get('/admin', (req, res) => {
  if (!req.session.authenticated) {
    return res.render('login', { t: req.t });
  }
  const items = loadItems();
  res.render('admin', { items, t: req.t });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === (process.env.ADMIN_PASSWORD || 'admin')) {
    req.session.authenticated = true;
    res.redirect('/admin');
  } else {
    res.render('login', { error: req.t('invalid_password'), t: req.t });
  }
});

app.post('/admin/add', (req, res) => {
  if (!req.session.authenticated) return res.redirect('/admin');
  const { id, name, price } = req.body;
  const items = loadItems();
  items.push({ id, name, price: parseFloat(price) });
  saveItems(items);
  res.redirect('/admin');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
