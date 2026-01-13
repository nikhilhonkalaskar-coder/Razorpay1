const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* ================== MYSQL CONNECTION ================== */

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/* ================== VERIFY DB CONNECTION ON START ================== */

(async () => {
  try {
    const conn = await db.getConnection();
    console.log("✅ MySQL Connected");
    conn.release();
  } catch (err) {
    console.error("❌ MySQL Connection Failed:", err.message);
    process.exit(1);
  }
})();

/* ================== RAW BODY FOR RAZORPAY ================== */

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);

/* ================== HELPERS ================== */

function verifySignature(req) {
  const signature = req.headers["x-razorpay-signature"];
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  return expected === signature;
}

function extractPayment(body) {
  return body?.payload?.payment?.entity || null;
}

/* ================== STORE PAYMENT ================== */

async function storePayment(payment, event) {
  // Allow both authorized & captured
  if (!["authorized", "captured"].includes(payment.status)) {
    console.log("⏭ Skipped:", payment.status);
    return;
  }

  const sql = `
    INSERT INTO crm_payments
    (payment_id, order_id, email, phone, customer_name, city, amount,
     currency, status, event, method, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE payment_id = payment_id
  `;

  const params = [
    payment.id,
    payment.order_id,
    payment.email || "",
    payment.contact || "",
    payment.notes?.name || "",
    payment.notes?.city || "",
    payment.amount / 100,
    payment.currency,
    payment.status,
    event,
    payment.method,
    new Date(payment.created_at * 1000)
  ];

  await db.execute(sql, params);
  console.log("✅ Stored:", payment.id);
}

/* ================== WEBHOOK ENDPOINT ================== */

app.post("/razorpay-webhook", async (req, res) => {
  console.log("📩 Webhook received");

  if (!verifySignature(req)) {
    console.log("❌ Invalid signature");
    return res.status(400).send("Invalid signature");
  }

  const event = req.body.event;
  const payment = extractPayment(req.body);

  if (!payment) {
    return res.status(200).send("No payment data");
  }

  try {
    await storePayment(payment, event);
    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ DB Error:", err.message);
    res.status(500).send("DB Error");
  }
});

/* ================== HEALTH CHECK ================== */

app.get("/", (req, res) => {
  res.send("✔ Razorpay Webhook Service Running");
});

/* ================== START SERVER ================== */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
