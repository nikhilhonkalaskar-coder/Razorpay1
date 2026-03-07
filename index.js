const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const AMOUNT_1500 = 150000;
const AMOUNT_96 = 9600;

/* ================== DATABASE ================== */
/* Works for Render / Supabase */

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },

  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

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

/* ================== SAFE DB QUERY ================== */

async function safeQuery(query, params) {
  try {
    return await db.query(query, params);
  } catch (err) {

    console.log("⚠️ DB retry...");

    await new Promise(r => setTimeout(r, 2000));

    return await db.query(query, params);
  }
}

/* ================== DUPLICATE CHECK ================== */

async function paymentExists(paymentId) {

  const result = await safeQuery(
    "SELECT payment_id FROM crm_payments WHERE payment_id=$1",
    [paymentId]
  );

  return result.rows.length > 0;
}

/* ================== STORE TO CRM ================== */

async function storePaymentToCRM(payment, event) {

  if (payment.status !== "captured") {
    console.log("⏭ Payment not captured yet");
    return;
  }

  if (await paymentExists(payment.id)) {
    console.log("⏭ Duplicate webhook ignored:", payment.id);
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

  /* Main CRM table */

  await safeQuery(sql("crm_payments"), params);
  console.log(`✅ Stored in crm_payments → ${payment.id}`);

  /* ₹1500 product */

  if (payment.amount === AMOUNT_1500) {

    await safeQuery(sql("crm_1500"), params);

    console.log(`✅ Stored in crm_1500 → ${payment.id}`);
  }

  /* ₹96 product */

  if (payment.amount === AMOUNT_96) {

    await safeQuery(sql("crm_96"), params);

    console.log(`✅ Stored in crm_96 → ${payment.id}`);
  }
}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {

  console.log("\n📩 Razorpay webhook received");

  /* Verify signature */

  if (!verifySignature(req)) {
    console.log("❌ Signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  /* ACK immediately */

  res.status(200).send("OK");

  try {

    const body = req.body;
    const event = body.event;

    /* Process only successful payments */

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

    try {

      await storePaymentToCRM(payment, event);

    } catch (dbError) {

      console.error("❌ Database error:", dbError.message);

    }

  } catch (err) {

    console.error("❌ Webhook error:", err);

  }

});

/* ================== HEALTH CHECK ================== */

app.get("/razorpay-webhook", (req, res) => {

  res.send("✔ Razorpay Webhook Active (PostgreSQL CRM)");

});

/* ================== START SERVER ================== */

app.listen(PORT, () => {

  console.log(`🚀 Server running on port ${PORT}`);

});
