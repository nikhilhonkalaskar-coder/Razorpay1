require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Amount slabs (in paise)
const AMOUNT_99 = 9900;
const AMOUNT_1500 = 150000;

/* ================== POSTGRES CONNECTION ================== */

const db = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  ssl: { rejectUnauthorized: false },
});

/* ================== HELPERS ================== */

function timestampInKolkata(unix) {
  return new Date(unix * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });
}

/* ================== STORE PAYMENT FUNCTION ================== */

async function storePaymentToCRM(payment, event) {
  if (payment.status !== "captured") return;

  try {
    // Deduplication check
    const exists = await db.query(
      "SELECT 1 FROM crm_payments WHERE payment_id = $1",
      [payment.id]
    );

    if (exists.rowCount > 0) {
      console.log("🔁 Duplicate ignored:", payment.id);
      return;
    }

    const sql = (table) => `
      INSERT INTO ${table}
      (payment_id, order_id, email, phone, customer_name, city,
       amount, currency, status, event, method, paid_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (payment_id) DO NOTHING
    `;

    const params = [
      payment.id,
      payment.order_id || "",
      payment.email || "",
      payment.contact || "",
      payment.notes?.name || "",
      payment.notes?.city || "",
      payment.amount / 100,
      payment.currency || "INR",
      payment.status,
      event,
      payment.method || "",
      new Date(payment.captured_at * 1000),
    ];

    await db.query(sql("crm_payments"), params);
    console.log(`✅ Stored in crm_payments → ${payment.id}`);

    if (payment.amount <= AMOUNT_99) {
      await db.query(sql("crm_99"), params);
      console.log(`✅ Stored in crm_99 → ${payment.id}`);
    } else if (payment.amount > AMOUNT_99 && payment.amount <= AMOUNT_1500) {
      await db.query(sql("crm_1500"), params);
      console.log(`✅ Stored in crm_1500 → ${payment.id}`);
    }
  } catch (err) {
    console.error("❌ Error storing payment:", err.message);
  }
}

/* ================== WEBHOOK ROUTE ================== */

// IMPORTANT: Use express.raw() for webhook to verify signature correctly
app.post(
  "/razorpay-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("\n📩 Razorpay webhook received");

    const signature = req.headers["x-razorpay-signature"];
    if (!signature) {
      console.log("❌ No signature header");
      return res.status(400).send("Signature missing");
    }

    const expectedSignature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(req.body)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.log("❌ Signature mismatch");
      return res.status(400).send("Invalid signature");
    }

    // Acknowledge immediately
    res.status(200).send("OK");

    try {
      const body = JSON.parse(req.body.toString());
      const event = body.event;

      const allowedEvents = [
        "payment.created",
        "payment.authorized",
        "payment.captured",
        "payment.failed",
      ];

      if (!allowedEvents.includes(event)) {
        console.log(`⏭ Ignored event: ${event}`);
        return;
      }

      const payment = body?.payload?.payment?.entity;
      if (!payment) {
        console.log("⚠️ No payment entity in payload");
        return;
      }

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
      console.error("❌ Webhook processing error:", err);
    }
  }
);

/* ================== TEST ROUTE ================== */

app.get("/razorpay-webhook", (req, res) => {
  res.send("✔ Razorpay Webhook Active (PostgreSQL CRM)");
});

/* ================== DB CONNECTION TEST ================== */

app.get("/db-test", async (req, res) => {
  try {
    const result = await db.query("SELECT NOW()");
    res.json({ now: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

