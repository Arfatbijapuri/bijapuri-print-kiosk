/**
 * QuickPrint Kiosk — backend server
 * ---------------------------------
 * Handles: file upload, Razorpay order creation, payment verification,
 * and a simple print-job queue that the shop-PC print-agent polls.
 *
 * SETUP:
 *   npm init -y
 *   npm install express multer razorpay cors dotenv better-sqlite3
 *
 * .env file (create this, never commit it):
 *   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
 *   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxx
 *   PORT=4000
 *
 * Run:
 *   node server.js
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Razorpay = require('razorpay');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

// ---- storage for uploaded files ----
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// ---- simple local database for orders / print queue ----
const db = new Database(path.join(__dirname, 'orders.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    file_path TEXT,
    original_name TEXT,
    copies INTEGER,
    color TEXT,
    size TEXT,
    sides TEXT,
    amount INTEGER,
    razorpay_order_id TEXT,
    payment_status TEXT DEFAULT 'pending',
    print_status TEXT DEFAULT 'queued',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// ---- Razorpay client ----
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// 1. Create order + store uploaded file
app.post('/api/create-order', upload.single('file'), async (req, res) => {
  try {
    const { copies, color, size, sides, amount } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const orderId = 'QP' + Date.now().toString(36).toUpperCase();
    const amountInRupees = Math.max(1, parseInt(amount, 10) || 1);

    const rpOrder = await razorpay.orders.create({
      amount: amountInRupees * 100, // paise
      currency: 'INR',
      receipt: orderId
    });

    db.prepare(`
      INSERT INTO orders (id, file_path, original_name, copies, color, size, sides, amount, razorpay_order_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, req.file.path, req.file.originalname, copies, color, size, sides, amountInRupees, rpOrder.id);

    res.json({ orderId, razorpayOrderId: rpOrder.id, amount: amountInRupees, currency: 'INR' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create order' });
  }
});

// 2. Verify payment signature, mark order paid + queued for print
app.post('/api/verify-payment', (req, res) => {
  const { orderId, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(razorpay_order_id + '|' + razorpay_payment_id)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  db.prepare(`UPDATE orders SET payment_status = 'paid', print_status = 'queued' WHERE id = ?`).run(orderId);
  res.json({ status: 'verified' });
});

// 3. Print agent (running on the shop PC) polls this to fetch queued jobs
app.get('/api/print-jobs/next', (req, res) => {
  const job = db.prepare(`SELECT * FROM orders WHERE payment_status = 'paid' AND print_status = 'queued' ORDER BY created_at ASC LIMIT 1`).get();
  if (!job) return res.json({ job: null });
  res.json({ job });
});

// 4. Print agent downloads the actual file
app.get('/api/print-jobs/:orderId/file', (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.orderId);
  if (!order) return res.status(404).end();
  res.download(order.file_path, order.original_name);
});

// 5. Print agent reports back success/failure
app.post('/api/print-jobs/:orderId/status', (req, res) => {
  const { status } = req.body; // 'printed' | 'failed'
  db.prepare(`UPDATE orders SET print_status = ? WHERE id = ?`).run(status, req.params.orderId);
  res.json({ ok: true });
});

// 6. Kiosk polls this to show "printing..." -> "done"
app.get('/api/print-status/:orderId', (req, res) => {
  const order = db.prepare(`SELECT print_status as status FROM orders WHERE id = ?`).get(req.params.orderId);
  if (!order) return res.status(404).json({ status: 'unknown' });
  res.json(order);
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`QuickPrint server running on port ${PORT}`));
