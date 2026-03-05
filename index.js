const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// amounts in paise
const AMOUNT_96 = 9600;
const AMOUNT_1500 = 150000;

/* ================== POSTGRES ================== */

const db = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false },
});

/* ================== RAW BODY ================== */

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

/* ================== VERIFY SIGNATURE ================== */

function verifySignature(req) {
  const signature = req.headers["x-razorpay-signature"];
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  return expected === signature;
}

/* ================== EXTRACT PAYMENT ================== */

function extractPayment(body) {
  return body?.payload?.payment?.entity || null;
}

/* ================== STORE PAYMENT ================== */

async function storePayment(payment) {
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
    "payment.captured",
    payment.method,
    new Date(payment.created_at * 1000),
  ];

  /* main CRM table */

  await db.query(sql("crm_payments"), params);
  console.log("✅ Stored in crm_payments");

  /* ₹96 entry offer */

  if (Number(payment.amount) === AMOUNT_96) {
    await db.query(sql("crm_96"), params);
    console.log("✅ Stored in crm_96");
  }

  /* ₹1500 upsell */

  if (Number(payment.amount) === AMOUNT_1500) {
    await db.query(sql("crm_1500"), params);
    console.log("✅ Stored in crm_1500");
  }
}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {
  console.log("\n📩 Razorpay webhook received");

  try {
    /* signature verification */

    if (!verifySignature(req)) {
      console.log("❌ Signature mismatch");
      return res.status(400).send("Invalid signature");
    }

    const body = req.body;
    const event = body.event;

    /* only process captured payment */

    if (event !== "payment.captured") {
      console.log(`⏭ Ignored event: ${event}`);
      return res.status(200).send("Ignored");
    }

    const payment = extractPayment(body);

    if (!payment) {
      console.log("⚠ No payment object found");
      return res.status(200).send("No payment");
    }

    const time = new Date(payment.created_at * 1000).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    console.log(`[${time}] 💰 Payment: ${payment.id}`);
    console.log(`[${time}] 💳 Status: ${payment.status}`);
    console.log(`[${time}] 💵 Amount: ₹${payment.amount / 100}`);
    console.log(`[${time}] 👤 Email: ${payment.email || "N/A"}`);
    console.log(`[${time}] 📞 Phone: ${payment.contact || "N/A"}`);
    console.log(`[${time}] 🧑 Name: ${payment.notes?.name || "N/A"}`);
    console.log(`[${time}] 🌆 City: ${payment.notes?.city || "N/A"}`);

    await storePayment(payment);

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Error");
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
