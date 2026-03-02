const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* ================== POSTGRES CONNECTION ================== */

const db = new Pool({
  connectionString: process.env.DATABASE_URL, // 👈 Use only this
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
});

/* 🔥 Optional Debug (Remove after testing) */
db.connect()
  .then(() => console.log("✅ DB Connected Successfully"))
  .catch(err => console.error("❌ DB Connection Error:", err));

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
  console.log(`✅ Stored in crm_payments → ${payment.id}`);

  if (payment.amount === 9900) {
    await db.query(sql("crm_99"), params);
    console.log(`✅ Stored in crm_99 → ${payment.id}`);
  }

  if (payment.amount === 150000) {
    await db.query(sql("crm_1500"), params);
    console.log(`✅ Stored in crm_1500 → ${payment.id}`);
  }

  if (payment.amount === 9600) {
    await db.query(sql("crm_96"), params);
    console.log(`✅ Stored in crm_96 → ${payment.id}`);
  }
}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {
  console.log("\n📩 Razorpay webhook received");

  if (!verifySignature(req)) {
    console.log("❌ Signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  // Acknowledge Razorpay immediately
  res.status(200).send("OK");

  try {
    const body = req.body;
    const event = body.event;

    if (
      ![
        "payment.created",
        "payment.authorized",
        "payment.captured",
        "payment.failed",
      ].includes(event)
    ) {
      console.log(`⏭ Ignored event: ${event}`);
      return;
    }

    const payment = extractPayment(body);
    if (!payment) return;

    console.log(`💰 Payment: ${payment.id}`);
    console.log(`💳 Status: ${payment.status}`);
    console.log(`💵 Amount: ₹${payment.amount / 100}`);

    await storePaymentToCRM(payment, event);
  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
});

/* ================== HEALTH CHECK ================== */

app.get("/", (req, res) => {
  res.send("✔ Razorpay Webhook Active (Render + Supabase)");
});

/* ================== START ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
