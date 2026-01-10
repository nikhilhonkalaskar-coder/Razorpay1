require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();

/* ================== CONFIG ================== */

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// CRM API endpoint (external)
const CRM_API_URL = process.env.CRM_API_URL;
const CRM_API_KEY = process.env.CRM_API_KEY;

// Payment amounts in paise
const AMOUNT_99 = 9900;
const AMOUNT_1500 = 150000;

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

/* ================== SEND TO CRM API ================== */

async function sendToCRMAPI(data) {
  await axios.post(CRM_API_URL, data, {
    headers: {
      "x-api-key": CRM_API_KEY,
      "Content-Type": "application/json",
    },
    timeout: 5000,
  });
}

/* ================== WEBHOOK ================== */

app.post("/razorpay-webhook", async (req, res) => {
  console.log("📩 Webhook received");

  if (!verifySignature(req)) {
    return res.status(400).send("Invalid signature");
  }

  res.send("OK");

  const body = req.body;
  const event = body.event;
  const payment = extractPayment(body);

  if (!payment || payment.status !== "captured") return;

  const payload = {
    payment_id: payment.id,
    order_id: payment.order_id,
    email: payment.email || "",
    phone: payment.contact || "",
    customer_name: payment.notes?.name || "",
    city: payment.notes?.city || "",
    amount: payment.amount / 100,
    currency: payment.currency,
    status: payment.status,
    event,
    method: payment.method,
    paid_at: new Date(payment.created_at * 1000),
    slab:
      payment.amount === AMOUNT_99
        ? "99"
        : payment.amount === AMOUNT_1500
        ? "1500"
        : "other",
  };

  try {
    await sendToCRMAPI(payload);
    console.log("✅ Sent to CRM API:", payment.id);
  } catch (err) {
    console.error("❌ CRM API Error:", err.message);
  }
});

/* ================== TEST ================== */

app.get("/", (req, res) => {
  res.send("🚀 Webhook API Running (No DB)");
});

/* ================== START ================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
