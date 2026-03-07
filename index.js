const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* Payment amounts */
const AMOUNT_96 = 9600;
const AMOUNT_1500 = 150000;

/* ================== DATABASE ================== */

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

/* Test connection */

async function testDB() {
  try {
    await db.query("SELECT NOW()");
    console.log("✅ PostgreSQL Connected");
  } catch (err) {
    console.error("❌ DB Connection Error:", err.message);
  }
}

testDB();

/* ================== RAW BODY ================== */

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);

/* ================== HELPERS ================== */

function timestampInKolkata(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false
  });
}

function verifySignature(req) {
  const signature = req.headers["x-razorpay-signature"];

  if (!signature) {
    console.log("❌ Missing Razorpay signature");
    return false;
  }

  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  return expected === signature;
}

function extractPayment(body) {
  return body?.payload?.payment?.entity || null;
}

/* ================== RETRY FUNCTION ================== */

async function retryQuery(query, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await db.query(query, params);
    } catch (err) {
      console.log(`⚠ DB retry ${i + 1}`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

/* ================== STORE PAYMENT ================== */

async function storePaymentToCRM(payment, event) {

  if (payment.status !== "captured") {
    console.log(`⏭ Skipped ${payment.id} status=${payment.status}`);
    return;
  }

  const insertSql = table => `
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
    new Date(payment.created_at * 1000)
  ];

  await retryQuery(insertSql("crm_payments"), params);
  console.log(`✅ Stored in crm_payments`);

  if (payment.amount === AMOUNT_96) {
    await retryQuery(insertSql("crm_96"), params);
    console.log(`✅ Stored in crm_96`);
  }

  if (payment.amount === AMOUNT_1500) {
    await retryQuery(insertSql("crm_1500"), params);
    console.log(`✅ Stored in crm_1500`);
  }
}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {

  console.log("\n📩 Razorpay Webhook Received");

  if (!verifySignature(req)) {
    return res.status(400).send("Invalid signature");
  }

  const event = req.body.event;
  const payment = extractPayment(req.body);

  if (!payment) {
    return res.status(200).send("No payment entity");
  }

  const time = timestampInKolkata(payment.created_at);

  const amount = payment.amount ? payment.amount / 100 : 0;
  const email = payment.email || "N/A";
  const phone = payment.contact || "N/A";
  const name = payment.notes?.name || "N/A";
  const city = payment.notes?.city || "N/A";

  console.log("\n================ PAYMENT RECEIVED ================");
  console.log(`[${time}] 💰 Payment ID : ${payment.id}`);
  console.log(`[${time}] 💳 Status     : ${payment.status}`);
  console.log(`[${time}] 💵 Amount     : ₹${amount}`);
  console.log(`[${time}] 🏦 Method     : ${payment.method}`);
  console.log(`[${time}] 👤 Email      : ${email}`);
  console.log(`[${time}] 📞 Phone      : ${phone}`);
  console.log(`[${time}] 🧑 Name       : ${name}`);
  console.log(`[${time}] 🌆 City       : ${city}`);
  console.log("=================================================\n");

  try {

    await storePaymentToCRM(payment, event);

    res.status(200).send("Webhook processed");

  } catch (err) {

    console.error("❌ Webhook processing failed:", err);

    res.status(500).send("Server error");
  }
});

/* ================== HEALTH CHECK ================== */

app.get("/", (req, res) => {
  res.send("✔ Razorpay Webhook Server Running");
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
