const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const app = express();

/* ================== CONFIG ================== */

// --- CRITICAL: These MUST be set in Render's Environment tab ---
// There are NO fallbacks. The app will crash if these are not set.
const {
  PORT = 3000,
  WEBHOOK_SECRET,
  DB_HOST,
  DB_USER,
  DB_PASS,
  DB_NAME,
} = process.env;

// Fail fast if essential variables are not set
if (!WEBHOOK_SECRET || !DB_HOST || !DB_USER || !DB_PASS || !DB_NAME) {
  console.error("FATAL: Missing one or more required environment variables (WEBHOOK_SECRET, DB_HOST, DB_USER, DB_PASS, DB_NAME).");
  console.error("Please set them in the Render dashboard and redeploy.");
  process.exit(1); // Exit the application with an error
}

// Payment amounts in paise
const AMOUNT_99 = 9900;
const AMOUNT_1500 = 150000;

/* ================== MYSQL CONNECTION ================== */

const db = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  connectionLimit: 10,
  acquireTimeout: 60000,
  timeout: 60000,
});

// Test the database connection on startup
db.getConnection()
  .then(conn => {
    console.log("✅ Successfully connected to the database.");
    conn.release();
  })
  .catch(err => {
    console.error("❌ FATAL: Could not connect to the database.", err.message);
    console.error("This is usually caused by:");
    console.error("1. Incorrect DB_HOST, DB_USER, DB_PASS, or DB_NAME in Render Environment.");
    console.error("2. The database user ('root') not having remote access permissions.");
    console.error("3. A firewall blocking port 3306 on your database server.");
    process.exit(1);
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
  if (!signature) {
    console.log("❌ Signature header missing.");
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

/* ================== STORE PAYMENT TO CRM ================== */

async function storePaymentToCRM(payment, event) {
  try {
    if (payment.status !== "captured") {
      console.log(`⏭ Skipped DB insert for Payment ID: ${payment.id}. Status is '${payment.status}', not 'captured'.`);
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

    await db.execute(insertSql("crm_payments"), params);
    console.log(`✅ Stored in crm_payments: ${payment.id}`);

    if (payment.amount === AMOUNT_99) {
      await db.execute(insertSql("crm_99"), params);
      console.log(`✅ Stored in crm_99: ${payment.id}`);
    }

    if (payment.amount === AMOUNT_1500) {
      await db.execute(insertSql("crm_1500"), params);
      console.log(`✅ Stored in crm_1500: ${payment.id}`);
    }
  } catch (err) {
    console.error("❌ DB Error for Payment ID:", payment.id);
    console.error("   Message:", err.message);
    console.error("   Stack:", err.stack);
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

  setImmediate(async () => {
    try {
      const body = req.body;
      const event = body.event;

      if (!["payment.created", "payment.authorized", "payment.captured", "payment.failed"].includes(event)) {
        console.log(`⏭ Skipping unhandled event: ${event}`);
        return;
      }

      const payment = extractPayment(body);
      if (!payment) {
        console.log("⏭ No payment entity found in webhook payload.");
        return;
      }

      const time = timestampInKolkata(payment.created_at);
      console.log(`\n[${time}] Processing Event: ${event} | Payment ID: ${payment.id} | Status: ${payment.status} | Amount: ₹${payment.amount / 100}`);

      await storePaymentToCRM(payment, event);
    } catch (err) {
      console.error("❌ Critical error in webhook processing:", err);
    }
  });
});

/* ================== TEST ROUTE ================== */

app.get("/razorpay-webhook", (req, res) => {
  res.status(200).send("✔ Razorpay Webhook Active");
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
