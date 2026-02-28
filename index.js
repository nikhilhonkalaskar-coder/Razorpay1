const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const AMOUNT_99 = 9900;
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
});

/* ================== RAW BODY FOR SIGNATURE ================== */

app.post(
  "/razorpay-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("\n📩 Razorpay webhook received");

    try {
      /* ===== VERIFY SIGNATURE ===== */

      const signature = req.headers["x-razorpay-signature"];

      const expected = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(req.body)
        .digest("hex");

      if (expected !== signature) {
        console.log("❌ Signature mismatch");
        return res.status(400).send("Invalid signature");
      }

      console.log("✅ Signature verified");

      // ACK immediately
      res.status(200).send("OK");

      /* ===== PARSE BODY ===== */

      const body = JSON.parse(req.body.toString());
      const event = body.event;

      // ✅ ONLY PROCESS payment.captured
      if (event !== "payment.captured") {
        console.log("⏭ Ignored event:", event);
        return;
      }

      const payment = body?.payload?.payment?.entity;
      if (!payment) {
        console.log("❌ No payment entity");
        return;
      }

      const time = new Date(payment.created_at * 1000).toLocaleString(
        "en-IN",
        { timeZone: "Asia/Kolkata", hour12: false }
      );

      console.log(`[${time}] 💰 Payment: ${payment.id}`);
      console.log(`[${time}] 💳 Status: ${payment.status}`);
      console.log(`[${time}] 💵 Amount: ₹${payment.amount / 100}`);
      console.log(`[${time}] 👤 Email: ${payment.email || "N/A"}`);
      console.log(`[${time}] 📞 Phone: ${payment.contact || "N/A"}`);
      console.log(`[${time}] 🧑 Name: ${payment.notes?.name || "N/A"}`);
      console.log(`[${time}] 🌆 City: ${payment.notes?.city || "N/A"}`);

      await storePaymentToCRM(payment, event);

      console.log("✅ Stored successfully");
    } catch (err) {
      console.error("❌ Webhook FULL error:", err);
    }
  }
);

/* ================== STORE TO CRM ================== */

async function storePaymentToCRM(payment, event) {
  if (payment.status !== "captured") return;

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

  await db.query(sql("crm_payments"), params);

  if (payment.amount === AMOUNT_99) {
    await db.query(sql("crm_99"), params);
  }

  if (payment.amount === AMOUNT_1500) {
    await db.query(sql("crm_1500"), params);
  }

  if (payment.amount === AMOUNT_96) {
    await db.query(sql("crm_96"), params);
  }
}

/* ================== HEALTH CHECK ================== */

app.get("/health", (req, res) => {
  res.send("OK");
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
