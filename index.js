const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== GLOBAL ERROR PROTECTION ================== */

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Promise Rejection:", err);
});

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Amounts in paise
const AMOUNT_1500 = 150000;
const AMOUNT_96 = 9600;

/* ================== POSTGRES CONNECTION ================== */

const db = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,

  ssl: { rejectUnauthorized: false },

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

/* handle pool errors */

db.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error", err);
});

/* keep DB alive (Render idle protection) */

setInterval(async () => {
  try {
    await db.query("SELECT 1");
  } catch (err) {
    console.log("Keepalive DB error:", err.message);
  }
}, 30000);

/* ================== RAW BODY ================== */

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
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

function timestampInKolkata(unix) {
  return new Date(unix * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });
}

/* ================== STORE PAYMENT ================== */

async function storePaymentToCRM(payment) {
  if (payment.status !== "captured") return;

  const sql = (table) => `
    INSERT INTO ${table}
    (payment_id, order_id, email, phone, customer_name, city,
     amount, currency, status, method, paid_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (payment_id) DO NOTHING
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
    payment.method,
    new Date(payment.created_at * 1000),
  ];

  /* store in master CRM */

  await db.query(sql("crm_payments"), params);
  console.log(`✅ Stored in crm_payments → ${payment.id}`);

  /* store based on product */

  if (payment.amount === AMOUNT_1500) {
    await db.query(sql("crm_1500"), params);
    console.log(`✅ Stored in crm_1500 → ${payment.id}`);
  }

  if (payment.amount === AMOUNT_96) {
    await db.query(sql("crm_96"), params);
    console.log(`✅ Stored in crm_96 → ${payment.id}`);
  }
}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {

  console.log("\n📩 Razorpay webhook received");

  /* verify signature */

  if (!verifySignature(req)) {
    console.log("❌ Signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  /* acknowledge webhook immediately */

  res.status(200).send("OK");

  try {
    const body = req.body;
    const event = body.event;

    /* only process captured payments */

    if (event !== "payment.captured") {
      console.log(`⏭ Ignored event: ${event}`);
      return;
    }

    const payment = extractPayment(body);
    if (!payment) return;

    const time = timestampInKolkata(payment.created_at);

    console.log(`[${time}] 💰 Payment: ${payment.id}`);
    console.log(`[${time}] 💳 Status: ${payment.status}`);
    console.log(`[${time}] 💵 Amount: ₹${payment.amount / 100}`);
    console.log(`[${time}] 👤 Email: ${payment.email || "N/A"}`);
    console.log(`[${time}] 📞 Phone: ${payment.contact || "N/A"}`);
    console.log(`[${time}] 🧑 Name: ${payment.notes?.name || "N/A"}`);
    console.log(`[${time}] 🌆 City: ${payment.notes?.city || "N/A"}`);

    await storePaymentToCRM(payment);

  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
});

/* ================== TEST ROUTE ================== */

app.get("/razorpay-webhook", (req, res) => {
  res.send("✔ Razorpay Webhook Active (PostgreSQL CRM)");
});

/* ================== HEALTH CHECK ================== */

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.send("Server + DB OK");
  } catch (err) {
    res.status(500).send("Database Error");
  }
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
