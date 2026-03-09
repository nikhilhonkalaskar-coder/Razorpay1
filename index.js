
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Amounts in paise
const AMOUNT_1500 = 150000;
const AMOUNT_96 = 9600;

/* ================== POSTGRES ================== */

const db = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 6543,
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

async function insertPayment(table, params, paymentId) {
  const sql = `
    INSERT INTO ${table}
    (payment_id, order_id, email, phone, customer_name, city,
     amount, currency, status, event, method, paid_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (payment_id) DO NOTHING
  `;

  const result = await db.query(sql, params);

  if (result.rowCount > 0) {
    console.log(`✅ Stored in ${table} → ${paymentId}`);
  } else {
    console.log(`⚠ Duplicate ignored in ${table} → ${paymentId}`);
  }
}

async function storePaymentToCRM(payment, event) {
  if (payment.status !== "captured") return;

  /* exact payment time */
  const paidTimestamp = payment.captured_at || payment.created_at;

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
    new Date(paidTimestamp * 1000),
  ];

  /* MAIN CRM TABLE */

  await insertPayment("crm_payments", params, payment.id);

  /* COURSE CRM TABLES */

  if (payment.amount === AMOUNT_1500) {
    await insertPayment("crm_1500", params, payment.id);
  }

  if (payment.amount === AMOUNT_96) {
    await insertPayment("crm_96", params, payment.id);
  }
}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {
  console.log("\n📩 Razorpay webhook received");

  /* VERIFY SIGNATURE */

  if (!verifySignature(req)) {
    console.log("❌ Signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  /* ACK FAST */

  res.status(200).send("OK");

  try {
    const body = req.body;
    const event = body.event;

    /* PROCESS ONLY CAPTURED PAYMENTS */

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
    console.error("❌ Webhook error:", err);
  }
});

/* ================== TEST ================== */

app.get("/razorpay-webhook", (req, res) => {
  res.send("✔ Razorpay Webhook Active (PostgreSQL CRM)");
});

/* ================== START ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

