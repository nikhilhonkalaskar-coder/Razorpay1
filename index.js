const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* ================== POSTGRES CONNECTION ================== */

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================== RAW BODY (REQUIRED FOR RAZORPAY) ================== */

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

function timestampInKolkata(unix) {
  return new Date(unix * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false
  });
}

/* ================== SAFE INSERT ================== */

async function insertSafe(table, params, paymentId) {

  const sql = `
    INSERT INTO ${table}
    (payment_id, order_id, email, phone, customer_name, city,
     amount, currency, status, event, method, paid_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (payment_id) DO NOTHING
  `;

  try {

    const result = await db.query(sql, params);

    if (result.rowCount === 0) {
      console.log(`⚠️ Duplicate ignored in ${table} → ${paymentId}`);
    } else {
      console.log(`✅ Stored in ${table} → ${paymentId}`);
    }

  } catch (err) {

    console.error(`❌ Insert error in ${table}`);
    console.error(err);

  }

}

/* ================== STORE PAYMENT ================== */

async function storePaymentToCRM(payment) {

  const params = [
    payment.id,
    payment.order_id || "",
    payment.email || "",
    payment.contact || "",
    payment.notes?.name || "",
    payment.notes?.city || "",
    payment.amount / 100,
    payment.currency,
    payment.status,
    "payment.captured",
    payment.method,
    new Date(payment.created_at * 1000)
  ];

  await insertSafe("crm_payments", params, payment.id);

}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {

  console.log("\n📩 Razorpay webhook received");

  try {

    /* ---------- VERIFY SIGNATURE ---------- */

    if (!verifySignature(req)) {
      console.log("❌ Signature mismatch");
      return res.status(400).send("Invalid signature");
    }

    const body = req.body;
    const event = body.event;

    if (event !== "payment.captured") {
      console.log(`⏭ Ignored event: ${event}`);
      return res.status(200).send("Ignored");
    }

    const payment = extractPayment(body);

    if (!payment) {
      console.log("❌ Payment object missing");
      return res.status(400).send("No payment object");
    }

    const time = timestampInKolkata(payment.created_at);

    console.log(`[${time}] 💰 Payment: ${payment.id}`);
    console.log(`[${time}] 💳 Status: ${payment.status}`);
    console.log(`[${time}] 💵 Amount: ₹${payment.amount / 100}`);
    console.log(`[${time}] 👤 Email: ${payment.email || "N/A"}`);
    console.log(`[${time}] 📞 Phone: ${payment.contact || "N/A"}`);
    console.log(`[${time}] 🧑 Name: ${payment.notes?.name || "N/A"}`);
    console.log(`[${time}] 🌆 City: ${payment.notes?.city || "N/A"}`);

    /* ---------- STORE PAYMENT ---------- */

    await storePaymentToCRM(payment);

    res.status(200).send("OK");

  } catch (err) {

    console.error("❌ Webhook error:");
    console.error(err);

    res.status(500).send("Server error");

  }

});

/* ================== TEST ROUTE ================== */

app.get("/", (req, res) => {
  res.send("✔ Razorpay Webhook Active");
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
