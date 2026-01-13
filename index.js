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
// Add connection limits for stability
connectionLimit: 10,
acquireTimeout: 60000,
timeout: 60000,
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

const isValid = expected === signature;
if (!isValid) {
console.log("❌ Signature mismatch.");
console.log(` Received: ${signature}`);
console.log(` Expected: ${expected}`);
}
return isValid;
}

function extractPayment(body) {
return body?.payload?.payment?.entity || null;
}

/* ================== STORE PAYMENT TO CRM ================== */

async function storePaymentToCRM(payment, event) {
try {
// --- KEY LOGIC: Only store payments that are successfully captured ---
// This is intentional. You only want to record fully successful transactions.
if (payment.status !== "captured") {
console.log(`⏭ Skipped DB insert for Payment ID: ${payment.id}. Status is '${payment.status}', not 'captured'.`);
return;
}

const insertSql = (table) => `INSERT INTO ${table}
(payment_id, order_id, email, phone, customer_name, city, amount, currency, status, event, method, paid_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE payment_id = payment_id`; // This assumes `payment_id` is a UNIQUE or PRIMARY key.

const params = [
payment.id,
payment.order_id,
payment.email || "",
payment.contact || "",
payment.notes?.name || "",
payment.notes?.city || "",
payment.amount / 100, // Convert paise to rupees
payment.currency,
payment.status,
event,
payment.method,
new Date(payment.created_at * 1000),
];

// Insert into master table always
await db.execute(insertSql("crm_payments"), params);
console.log(`✅ Successfully stored in crm_payments: ${payment.id}`);

// Insert into 99 table if ₹99 payment
if (payment.amount === AMOUNT_99) {
await db.execute(insertSql("crm_99"), params);
console.log(`✅ Successfully stored in crm_99: ${payment.id}`);
}

// Insert into 1500 table if ₹1500 payment
if (payment.amount === AMOUNT_1500) {
await db.execute(insertSql("crm_1500"), params);
console.log(`✅ Successfully stored in crm_1500: ${payment.id}`);
}
} catch (err) {
// --- IMPROVED ERROR LOGGING ---
console.error("❌ Database Error during CRM insert for Payment ID:", payment.id);
console.error(" Error Message:", err.message);
console.error(" Error Stack:", err.stack); // Log the full stack trace for deeper debugging
}
}

/* ================== WEBHOOK HANDLER ================== */

app.post("/razorpay-webhook", async (req, res) => {
console.log("\n📩 Webhook received");

if (!verifySignature(req)) {
return res.status(400).send("Invalid signature");
}

// Acknowledge receipt immediately
res.status(200).send("OK");

// Process the webhook asynchronously
// Using setImmediate is often better than setTimeout for this pattern
setImmediate(async () => {
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
console.log(`⏭ Skipping unhandled event: ${event}`);
return;
}

const payment = extractPayment(body);
if (!payment) {
console.log("⏭ No payment entity found in webhook payload.");
return;
}

const time = timestampInKolkata(payment.created_at);
console.log(`\n[${time}] Processing Event: ${event}`);
console.log(` 💰 Payment ID: ${payment.id}`);
console.log(` 💳 Status: ${payment.status}`);
console.log(` 👤 Email: ${payment.email || "N/A"}`);
console.log(` 📞 Contact: ${payment.contact || "N/A"}`);
console.log(` 🧑 Name: ${payment.notes?.name || "N/A"}`);
console.log(` 🌆 City: ${payment.notes?.city || "N/A"}`);
console.log(` 💵 Amount: ₹${payment.amount / 100}`);

await storePaymentToCRM(payment, event);
} catch (err) {
console.error("❌ Critical error in webhook processing:", err);
}
});
});

/* ================== TEST ROUTE ================== */

app.get("/razorpay-webhook", (req, res) => {
res.status(200).send("✔ Razorpay Webhook Active (CRM ONLY)");
});

/* ================== START SERVER ================== */

app.listen(PORT, () => {
console.log(`🚀 Server running on port ${PORT}`);
});
