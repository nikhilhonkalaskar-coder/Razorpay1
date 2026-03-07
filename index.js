const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "Tbipl@123";

const AMOUNT_96 = 9600;
const AMOUNT_1500 = 150000;

/* ================== POSTGRES CONNECTION ================== */

const db = new Pool({
  host: "aws-1-ap-south-1.pooler.supabase.com",
  user: "postgres.rdutjyuqvnzkgjodamue",
  password: "5DsbSqyMbDgA3Ibw",
  database: "postgres",
  port: 5432,
  ssl: { rejectUnauthorized: false },
  max: 10
});

/* ================== DB CONNECTION TEST ================== */

db.query("SELECT NOW()")
  .then(() => console.log("✅ PostgreSQL Connected"))
  .catch(err => console.error("❌ DB Connection Error:", err.message));

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
    console.log("❌ Missing signature");
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

/* ================== STORE PAYMENT ================== */

async function storePaymentToCRM(payment, event) {

  if (payment.status !== "captured") {
    console.log(`⏭ Skipped ${payment.id} status=${payment.status}`);
    return;
  }

  const insertSql = (table) => `
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

  await db.query(insertSql("crm_payments"), params);
  console.log(`✅ Stored in crm_payments: ${payment.id}`);

  if (payment.amount === AMOUNT_96) {
    await db.query(insertSql("crm_96"), params);
    console.log(`✅ Stored in crm_96: ${payment.id}`);
  }

  if (payment.amount === AMOUNT_1500) {
    await db.query(insertSql("crm_1500"), params);
    console.log(`✅ Stored in crm_1500: ${payment.id}`);
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
    return res.status(200).send("No payment");
  }

  const time = timestampInKolkata(payment.created_at);

  /* ===== LOG PAYMENT DETAILS ===== */

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

    res.status(200).send("OK");

  } catch (err) {

    console.error("❌ Webhook error:", err);

    res.status(500).send("Server error");
  }
});

/* ================== HEALTH CHECK ================== */

app.get("/razorpay-webhook", (req, res) => {
  res.send("✔ Razorpay Webhook Active");
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
