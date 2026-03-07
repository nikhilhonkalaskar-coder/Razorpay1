const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

/*
PUT YOUR SUPABASE DATABASE URL HERE
*/
const connectionString =
"postgresql://postgres.rdutjyuqvnzkgjodamue:KW4mEF3ZRLWqiZsg@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";

/* PostgreSQL Pool */
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

/* Test Database Connection */
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

/* Razorpay Webhook */
app.post("/webhook", async (req, res) => {
  try {

    const event = req.body.event;

    if (event === "payment.captured") {

      const payment = req.body.payload.payment.entity;

      await pool.query(
        `INSERT INTO crm_payments
        (payment_id, order_id, email, phone, customer_name, city, amount, currency, status, event, method)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (payment_id) DO NOTHING`,
        [
          payment.id,
          payment.order_id,
          payment.email,
          payment.contact,
          payment.notes?.name || null,
          payment.notes?.city || null,
          payment.amount / 100,
          payment.currency,
          payment.status,
          event,
          payment.method
        ]
      );

      console.log("💰 Payment stored:", payment.id);
    }

    res.status(200).json({ status: "ok" });

  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Error");
  }
});

/* Test Route */
app.get("/", (req, res) => {
  res.send("Razorpay Webhook Server Running");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
