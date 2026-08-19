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

// ---- simple JSON-file "database" for orders / print queue ----
// (Avoids native modules like better-sqlite3, which fail to compile on
// some free hosting tiers. Fine for a single-shop kiosk's order volume.)
const DB_FILE = path.join(__dirname, 'orders.json');
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');

function readOrders() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeOrders(orders) {
  fs.writeFileSync(DB_FILE, JSON.stringify(orders, null, 2));
}
const db = {
  insertOrder(order) {
    const orders = readOrders();
    orders.push(order);
    writeOrders(orders);
  },
  updateOrder(id, updates) {
    const orders = readOrders();
    const idx = orders.findIndex(o => o.id === id);
    if (idx !== -1) Object.assign(orders[idx], updates);
    writeOrders(orders);
  },
  getOrder(id) {
    return readOrders().find(o => o.id === id);
  },
  getNextQueuedJob() {
    const orders = readOrders();
    return orders.find(o => o.payment_status === 'paid' && o.print_status === 'queued');
  }
};

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

    db.insertOrder({
      id: orderId,
      file_path: req.file.path,
      original_name: req.file.originalname,
      copies: parseInt(copies, 10) || 1,
      color, size, sides,
      amount: amountInRupees,
      razorpay_order_id: rpOrder.id,
      payment_status: 'pending',
      print_status: 'queued',
      created_at: new Date().toISOString()
    });

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

  db.updateOrder(orderId, { payment_status: 'paid', print_status: 'queued' });
  res.json({ status: 'verified' });
});

// 3. Print agent (running on the shop PC) polls this to fetch queued jobs
app.get('/api/print-jobs/next', (req, res) => {
  const job = db.getNextQueuedJob();
  if (!job) return res.json({ job: null });
  res.json({ job });
});

// 4. Print agent downloads the actual file
app.get('/api/print-jobs/:orderId/file', (req, res) => {
  const order = db.getOrder(req.params.orderId);
  if (!order) return res.status(404).end();
  res.download(order.file_path, order.original_name);
});

// 5. Print agent reports back success/failure
app.post('/api/print-jobs/:orderId/status', (req, res) => {
  const { status } = req.body; // 'printed' | 'failed'
  db.updateOrder(req.params.orderId, { print_status: status });
  res.json({ ok: true });
});

// 6. Kiosk polls this to show "printing..." -> "done"
app.get('/api/print-status/:orderId', (req, res) => {
  const order = db.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ status: 'unknown' });
  res.json({ status: order.print_status });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`QuickPrint server running on port ${PORT}`));
