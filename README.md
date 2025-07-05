# Metin2 Itemshop

This project is a simple web-based itemshop for Metin2 built with Node.js and Express. It supports multiple languages (English and Romanian), a basic admin panel and Stripe payments.

## Setup

```bash
npm install
npm start
```

Set the following environment variables:

- `STRIPE_SECRET_KEY` - Stripe API key used for payments
- `SESSION_SECRET` - secret used to sign the session cookie
- `ADMIN_PASSWORD_HASH` - bcrypt hash for the admin password

If `ADMIN_PASSWORD_HASH` is not provided, the default password is `admin`.

Item data is stored in a SQLite database located at `data/items.db`. The file is
created automatically on first run and seeded with the contents of
`data/items.json` if it is empty.

The app will run on `http://localhost:3000` by default.
