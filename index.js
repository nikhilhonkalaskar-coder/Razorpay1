const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

/* ===== SUPABASE DATABASE CONNECTION ===== */

const connectionString =
"postgresql://postgres.rdutjyuqvnzkgjodamue:m8Z3XgBu1owxSHfQ@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true";

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});


/* ===== TEST DATABASE CONNECTION ===== */

async function testDB() {
  try {
    const res = await pool.query("SELECT NOW()");
    console.log("✅ Database connected successfully");
    console.log("Server time:", res.rows[0].now);
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
  }
}

testDB();

/* ===== HOME ROUTE ===== */

app.get("/", (req, res) => {
  res.send("🚀 Razorpay Webhook Server Running");
});

/* ===== RAZORPAY WEBHOOK ===== */

app.post("/webhook", async (req, res) => {
  try {

    const event = req.body.event;

    if (event === "payment.captured") {

      const payment = req.body.payload.payment.entity;

      const time = new Date().toISOString();

      const amount = payment.amount ? payment.amount / 100 : 0;
      const email = payment.email || "N/A";
      const phone = payment.contact || "N/A";
      const name = payment.notes?.name || "N/A";
      const city = payment.notes?.city || "N/A";

      /* ===== LOG PAYMENT DETAILS ===== */

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

      /* ===== STORE PAYMENT IN DATABASE ===== */

      await pool.query(
        `INSERT INTO crm_payments
        (payment_id, order_id, email, phone, customer_name, city, amount, currency, status, event, method)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (payment_id) DO NOTHING`,
        [
          payment.id,
          payment.order_id,
          email,
          phone,
          name,
          city,
          amount,
          payment.currency,
          payment.status,
          event,
          payment.method
        ]
      );

      console.log(`[${time}] ✅ Payment stored in database`);
    }

    res.status(200).json({ status: "ok" });

  } catch (err) {

    console.error("❌ Webhook error:", err.message);
    res.status(500).send("Server Error");

  }
});

/* ===== START SERVER ===== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

