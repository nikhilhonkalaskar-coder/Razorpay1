const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "Tbipl@123";

// Payment amounts in paise
const AMOUNT_99 = 9900;
const AMOUNT_1500 = 150000;

/* ================== MYSQL CONNECTION ================== */

const db = mysql.createPool({
  host: process.env.DB_HOST || "61.2.229.88",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "ebiztech99",
  database: process.env.DB_NAME || "tushar_bumkar_institute_database",
});

/* ================== RAW BODY (for signature verification) ================== */

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

/* ================== HELPERS ================== */

function timestampInKolkata(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });
}

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

/* ================== STORE PAYMENT TO CRM ================== */

async function storePaymentToCRM(payment, event) {
  try {
    if (payment.status !== "captured") {
      console.log(`⏭ Skipped CRM insert (status: ${payment.status})`);
      return;
    }

    const insertSql = (table) => `INSERT INTO ${table}
      (payment_id, order_id, email, phone, customer_name, city, amount, currency, status, event, method, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE payment_id = payment_id`;

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

    // Insert into master table always
    await db.execute(insertSql("crm_payments"), params);
    console.log(`✅ Stored in crm_payments: ${payment.id}`);

    // Insert into 99 table if ₹99 payment
    if (payment.amount === AMOUNT_99) {
      await db.execute(insertSql("crm_99"), params);
      console.log(`✅ Stored in crm_99: ${payment.id}`);
    }

    // Insert into 1500 table if ₹1500 payment
    if (payment.amount === AMOUNT_1500) {
      await db.execute(insertSql("crm_1500"), params);
      console.log(`✅ Stored in crm_1500: ${payment.id}`);
    }
  } catch (err) {
    console.error("❌ CRM DB Error:", err.message);
  }
}

/* ================== WEBHOOK HANDLER ================== */

app.post("/razorpay-webhook", async (req, res) => {
  console.log("\n📩 Webhook received");

  if (!verifySignature(req)) {
    console.log("❌ Invalid signature");
    return res.status(400).send("Invalid signature");
  }

  res.status(200).send("OK");

  setTimeout(async () => {
    try {
      const body = req.body;
      const event = body.event;

      // Only handle payment events you want
      if (
        ![
          "payment.created",
          "payment.authorized",
          "payment.captured",
          "payment.failed",
        ].includes(event)
      ) {
        console.log(`⏭ Skipping event: ${event}`);
        return;
      }

      const payment = extractPayment(body);
      if (!payment) {
        console.log("⏭ No payment data found");
        return;
      }

      const time = timestampInKolkata(payment.created_at);
      console.log(`[${time}] 💰 Payment ID: ${payment.id}`);
      console.log(`[${time}] 💳 Status: ${payment.status} (${event})`);
      console.log(`[${time}] 👤 Email: ${payment.email || "N/A"}`);
      console.log(`[${time}] 📞 Contact: ${payment.contact || "N/A"}`);
      console.log(`[${time}] 🧑 Name: ${payment.notes?.name || "N/A"}`);
      console.log(`[${time}] 🌆 City: ${payment.notes?.city || "N/A"}`);
      console.log(`[${time}] 💵 Amount Paid: ₹${payment.amount / 100}`);

      await storePaymentToCRM(payment, event);
    } catch (err) {
      console.error("❌ Webhook processing error:", err);
    }
  }, 5);
});

/* ================== TEST ROUTE ================== */

app.get("/razorpay-webhook", (req, res) => {
  res.status(200).send("✔ Razorpay Webhook Active (CRM ONLY)");
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
