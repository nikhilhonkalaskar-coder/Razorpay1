const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const AMOUNT_1500 = 150000;
const AMOUNT_96 = 9600;

/* ================== POSTGRES CONNECTION ================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

/* ===== TEST DATABASE CONNECTION ===== */

async function testDB() {
  try {
    const client = await pool.connect();
    const res = await client.query("SELECT NOW()");
    console.log("✅ Database connected successfully");
    console.log("📅 DB Server Time:", res.rows[0].now);
    client.release();
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
}

testDB();

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

/* ================== STORE TO CRM ================== */

async function storePaymentToCRM(payment, event) {

  const sql = (table) => `
    INSERT INTO ${table}
    (payment_id, order_id, email, phone, customer_name, city,
     amount, currency, status, event, method, paid_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
    event,
    payment.method,
    new Date(payment.created_at * 1000),
  ];

  async function insert() {

    const client = await pool.connect();

    try {

      await client.query(sql("crm_payments"), params);
      console.log(`✅ Stored in crm_payments → ${payment.id}`);

      if (payment.amount === AMOUNT_1500) {
        await client.query(sql("crm_1500"), params);
        console.log(`✅ Stored in crm_1500 → ${payment.id}`);
      }

      if (payment.amount === AMOUNT_96) {
        await client.query(sql("crm_96"), params);
        console.log(`✅ Stored in crm_96 → ${payment.id}`);
      }

    } finally {
      client.release();
    }
  }

  try {

    await insert();

  } catch (err) {

    console.log("⚠ DB timeout, retrying...");

    try {
      await insert();
      console.log("✅ Retry successful");
    } catch (err2) {
      console.error("❌ DB Insert Error:", err2.message);
    }

  }
}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {

  console.log("\n📩 Razorpay webhook received");

  if (!verifySignature(req)) {
    console.log("❌ Signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  res.status(200).send("OK");

  try {

    const body = req.body;
    const event = body.event;

    /* ONLY PROCESS CAPTURED PAYMENTS */

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

    await storePaymentToCRM(payment, event);

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

/* ================== TEST ROUTE ================== */

app.get("/razorpay-webhook", (req, res) => {
  res.send("✔ Razorpay Webhook Active (Captured Payments Only)");
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
