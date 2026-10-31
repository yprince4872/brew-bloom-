require("dotenv").config();
const express = require("express"), mongoose = require("mongoose"), jwt = require("jsonwebtoken"),
  crypto = require("crypto"), path = require("path");
const { MONGODB_URI, JWT_SECRET, ADMIN_PIN, UPI_ID = "", RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, CAFE_NAME = "Brew & Bloom", PORT = 3000 } = process.env;
if (!MONGODB_URI || !JWT_SECRET || !ADMIN_PIN || !RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) { console.error("MONGODB_URI, JWT_SECRET, ADMIN_PIN, RAZORPAY_KEY_ID aur RAZORPAY_KEY_SECRET .env mein set karo"); process.exit(1); }

const app = express();
app.set("trust proxy", 1);
app.use((req, res, next) => req.path === "/api/razorpay/webhook" ? next() : express.json({ limit: req.path.startsWith("/api/admin/menu") ? "1mb" : "50kb" })(req, res, next));

/* ---------- models ---------- */
const { Schema } = mongoose;
const Menu = mongoose.model("Menu", new Schema({
  name: String, category: String, price: Number, emoji: String, description: String,
  available: { type: Boolean, default: true },
  hasImage: { type: Boolean, default: false }, imgMime: String, imgData: { type: Buffer, select: false }
}, { timestamps: true }));
const User = mongoose.model("User", new Schema({
  name: String, phone: { type: String, unique: true }, salt: String, hash: String,
  fails: { type: Number, default: 0 }, lockUntil: Date
}, { timestamps: true }));
const Booking = mongoose.model("Booking", new Schema({
  user: { type: Schema.Types.ObjectId, ref: "User", index: true },
  name: String, phone: String, cabin: Number,            // cabin 0 = block for all cabins
  date: String, start: String, end: String, startMin: Number, endMin: Number,
  note: String, reason: String,
  hours: Number, total: Number, advance: Number, paid: { type: Boolean, default: false }, rzpOrderId: { type: String, index: true }, payId: String,
  status: { type: String, default: "Pending" }            // Pending, Confirmed, Cancelled, Blocked
}, { timestamps: true }));
const Order = mongoose.model("Order", new Schema({
  code: { type: String, unique: true }, name: String, phone: String, tableNo: String, note: String,
  txn: { type: String, unique: true },
  items: [{ name: String, qty: Number, price: Number }],
  total: Number, status: { type: String, default: "New" },
  rzpOrderId: { type: String, index: true }, paid: { type: Boolean, default: false },
  user: { type: Schema.Types.ObjectId, ref: "User", index: true }
}, { timestamps: true }));
const Setting = mongoose.model("Setting", new Schema({ key: { type: String, unique: true }, value: String }));

/* ---------- helpers ---------- */
const str = (v, n) => String(v ?? "").trim().slice(0, n);
const bad = (res, m, c = 400) => res.status(c).json({ error: m });
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); bad(res, "Server error, dobara try karo", 500); });
const eq = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
const hits = new Map();
const limit = (max, ms) => (req, res, next) => {
  const k = req.path + req.ip, now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < ms);
  if (h.length >= max) return bad(res, "Bahut zyada requests, thodi der baad try karo", 429);
  h.push(now); hits.set(k, h); next();
};
setInterval(() => hits.clear(), 3600000).unref();
const DEF = {
  name: CAFE_NAME, upi: UPI_ID,
  heroTitle: "Brew slowly. Bloom loudly.",
  heroText: "A neighbourhood café for long conversations, good beans and food made from scratch. Order from your table, pay by UPI.",
  storyTitle: "Beans we know by name",
  storyText: "We buy from three estates in Chikmagalur and Coorg, roast in small batches each week, and brew every cup to order. Nothing sits in a flask.",
  hours: "Open every day, 8 am to 11 pm", address: "", phone: "",
  cabinOpen: "10:00", cabinClose: "22:00", cabinSlot: "30", cabinRate: "300", cabinAdvance: "100", cab1: "1", cab2: "1", cab3: "1"
};
async function getCfg() {
  const rows = await Setting.find({ key: { $in: Object.keys(DEF) } });
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return Object.fromEntries(Object.entries(DEF).map(([k, v]) => [k, m[k] !== undefined ? m[k] : v]));
}
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function readImg(v) {   // data URL -> buffer, max 450 KB
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(v || ""));
  if (!m) return null;
  const b = Buffer.from(m[2], "base64");
  return b.length > 0 && b.length <= 450000 ? { imgData: b, imgMime: m[1], hasImage: true } : null;
}
const toMin = t => { const [a, b] = String(t).split(":"); return (+a) * 60 + (+b); };
const hm = n => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
const T_OK = /^([01]\d|2[0-3]):[0-5]\d$/, D_OK = /^\d{4}-\d{2}-\d{2}$/;
const nowMin = () => toMin(new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
const maxDate = () => new Date(Date.now() + 30 * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
async function cabinCfg() {
  const g = await getCfg();
  return { open: toMin(g.cabinOpen), close: toMin(g.cabinClose), slot: parseInt(g.cabinSlot) || 60,
    rate: parseInt(g.cabinRate) || 300, advance: parseInt(g.cabinAdvance) || 100,
    cabins: [1, 2, 3].map(id => ({ id, active: g["cab" + id] !== "0" })) };
}
// Ye bookings cabin ko hold karti hain: paid Pending, Confirmed, admin Blocked, aur 10 minute tak payment-wali try
const holdQ = () => ({ $or: [{ status: { $in: ["Pending", "Confirmed", "Blocked"] } },
  { status: "Awaiting payment", createdAt: { $gt: new Date(Date.now() - 10 * 60000) } }] });
const OVL = (s, e) => ({ startMin: { $lt: e }, endMin: { $gt: s } });
const clash = (date, cabin, s, e, skip) => Booking.exists({
  date, cabin: { $in: [cabin, 0] }, ...holdQ(), ...OVL(s, e), ...(skip ? { _id: { $ne: skip } } : {})
});
// sirf paid / confirmed / blocked bookings gino (payment-wali try ko nahi)
const paidClash = (date, cabin, s, e, skip) => Booking.exists({
  date, cabin: { $in: [cabin, 0] }, status: { $in: ["Pending", "Confirmed", "Blocked"] }, ...OVL(s, e), ...(skip ? { _id: { $ne: skip } } : {})
});
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString("hex");
const userTok = u => jwt.sign({ r: "user", id: String(u._id) }, JWT_SECRET, { expiresIn: "30d" });
const userOut = u => ({ name: u.name, phone: u.phone });
const userAuth = async (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), JWT_SECRET);
    if (p.r !== "user") throw 0;
    const u = await User.findById(p.id);
    if (!u) throw 0;
    req.user = u; next();
  } catch { bad(res, "Pehle login karo", 401); }
};
const pub = m => ({
  _id: m._id, name: m.name, category: m.category, price: m.price, emoji: m.emoji,
  description: m.description, available: m.available,
  img: m.hasImage ? `/api/menu/${m._id}/image?v=${m.updatedAt ? m.updatedAt.getTime() : 0}` : ""
});
const cleanItem = b => ({
  name: str(b.name, 80), category: str(b.category, 40) || "Other", price: Math.round(Number(b.price)),
  emoji: str(b.emoji, 8) || "🍽️", description: str(b.description, 200), available: b.available !== false
});

/* ---------- pages (sirf ye do files serve hoti hain) ---------- */
app.get("/", (q, r) => r.sendFile(path.join(__dirname, "index.html")));
app.get("/admin", (q, r) => r.sendFile(path.join(__dirname, "admin.html")));

/* ---------- public API ---------- */
app.get("/api/config", wrap(async (q, r) => r.json(await getCfg())));
app.get("/api/menu", wrap(async (q, r) => r.json((await Menu.find().sort({ category: 1, createdAt: 1 })).map(pub))));
app.get("/api/menu/:id/image", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
  const m = await Menu.findById(req.params.id).select("+imgData");
  if (!m || !m.hasImage || !m.imgData) return res.sendStatus(404);
  res.set({ "Content-Type": m.imgMime, "Cache-Control": "public, max-age=31536000, immutable" });
  res.send(m.imgData);
}));

const sigOk = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function markPaid(rzpOrderId, paymentId) {
  return Order.findOneAndUpdate({ rzpOrderId, paid: { $ne: true } },
    { paid: true, status: "New", txn: String(paymentId).toUpperCase() }, { new: true });
}

/* Step 1: order banao, total server khud nikalta hai, phir Razorpay order banta hai */
app.post("/api/orders/create", userAuth, limit(15, 600000), wrap(async (req, res) => {
  const name = req.user.name, phone = req.user.phone,
    tableNo = str(req.body.tableNo, 10), note = str(req.body.note, 200);
  const raw = Array.isArray(req.body.items) ? req.body.items.slice(0, 40) : [];
  const ids = raw.map(i => String(i.id)).filter(id => mongoose.isValidObjectId(id));
  const found = await Menu.find({ _id: { $in: ids }, available: true });
  const items = []; let total = 0;
  for (const i of raw) {
    const m = found.find(d => String(d._id) === String(i.id)), qty = Math.min(20, parseInt(i.qty) || 0);
    if (!m || qty < 1) continue;
    items.push({ name: m.name, qty, price: m.price }); total += m.price * qty;   // price hamesha database se
  }
  if (!items.length) return bad(res, "Cart khali hai ya items available nahi hain");
  const code = "BB" + Date.now().toString().slice(-6) + Math.floor(Math.random() * 10);
  const r = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(RAZORPAY_KEY_ID + ":" + RAZORPAY_KEY_SECRET).toString("base64") },
    body: JSON.stringify({ amount: total * 100, currency: "INR", receipt: code, notes: { name, phone } })
  });
  const rz = await r.json();
  if (!r.ok) { console.error("Razorpay error:", rz); return bad(res, "Payment shuru nahi ho paya, dobara try karo", 502); }
  await Order.create({ user: req.user._id, code, name, phone, tableNo, note, items, total, txn: "PENDING-" + code, status: "Awaiting payment", paid: false, rzpOrderId: rz.id });
  res.json({ key: RAZORPAY_KEY_ID, orderId: rz.id, amount: rz.amount, code });
}));

/* Step 2: payment ke baad signature verify, tabhi order paid maana jata hai */
app.post("/api/orders/verify", limit(20, 600000), wrap(async (req, res) => {
  const oid = str(req.body.orderId, 40), pid = str(req.body.paymentId, 40), sig = str(req.body.signature, 128);
  const exp = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(oid + "|" + pid).digest("hex");
  if (!sigOk(sig, exp)) return bad(res, "Payment verify nahi hua");
  const o = (await markPaid(oid, pid)) || (await Order.findOne({ rzpOrderId: oid, paid: true }));
  if (!o) return bad(res, "Order nahi mila", 404);
  res.json({ code: o.code, name: o.name, txn: o.txn, total: o.total });
}));

/* Backup: agar customer payment ke baad tab band kar de, webhook order ko paid kar deta hai */
app.post("/api/razorpay/webhook", express.raw({ type: "application/json" }), wrap(async (req, res) => {
  if (!RAZORPAY_WEBHOOK_SECRET) return res.sendStatus(200);
  const exp = crypto.createHmac("sha256", RAZORPAY_WEBHOOK_SECRET).update(req.body).digest("hex");
  if (!sigOk(String(req.headers["x-razorpay-signature"] || ""), exp)) return res.sendStatus(400);
  const ev = JSON.parse(req.body.toString()), p = ev.payload && ev.payload.payment && ev.payload.payment.entity;
  if (ev.event === "payment.captured" && p && p.order_id) { await markPaid(p.order_id, p.id); await markBookingPaid(p.order_id, p.id); }
  res.sendStatus(200);
}));

/* ---------- customer accounts (mobile number + PIN) ---------- */
const phoneOk = p => /^\d{10}$/.test(p), pinOk = p => /^\d{4,6}$/.test(p);
app.post("/api/auth/register", limit(10, 3600000), wrap(async (req, res) => {
  const name = str(req.body.name, 60), phone = str(req.body.phone, 10), pin = str(req.body.pin, 6);
  if (!name) return bad(res, "Apna naam daalo");
  if (!phoneOk(phone)) return bad(res, "10 digit ka mobile number daalo");
  if (!pinOk(pin)) return bad(res, "PIN 4 se 6 digit ka hona chahiye");
  if (await User.exists({ phone })) return bad(res, "Is number se account pehle se hai, login karo");
  const salt = crypto.randomBytes(16).toString("hex");
  const u = await User.create({ name, phone, salt, hash: hashPin(pin, salt) });
  res.json({ token: userTok(u), user: userOut(u) });
}));
app.post("/api/auth/login", limit(20, 900000), wrap(async (req, res) => {
  const phone = str(req.body.phone, 10), pin = str(req.body.pin, 6), msg = "Mobile number ya PIN galat hai";
  const u = phoneOk(phone) ? await User.findOne({ phone }) : null;
  if (!u) return bad(res, msg, 401);
  if (u.lockUntil && u.lockUntil > new Date()) return bad(res, "Bahut baar galat PIN daala, 15 minute baad try karo", 429);
  if (!(pinOk(pin) && sigOk(hashPin(pin, u.salt), u.hash))) {
    u.fails = (u.fails || 0) + 1;
    if (u.fails >= 5) { u.lockUntil = new Date(Date.now() + 15 * 60000); u.fails = 0; }
    await u.save(); return bad(res, msg, 401);
  }
  u.fails = 0; u.lockUntil = undefined; await u.save();
  res.json({ token: userTok(u), user: userOut(u) });
}));
app.get("/api/me", userAuth, (req, res) => res.json(userOut(req.user)));
app.get("/api/my/orders", userAuth, wrap(async (req, res) =>
  res.json(await Order.find({ user: req.user._id, paid: true }).sort({ createdAt: -1 }).limit(50).select("code items total status createdAt tableNo"))));
app.get("/api/my/bookings", userAuth, wrap(async (req, res) =>
  res.json(await Booking.find({ user: req.user._id, status: { $nin: ["Blocked", "Awaiting payment"] } }).sort({ date: -1, startMin: 1 }).limit(50))));
app.post("/api/my/bookings/:id/cancel", userAuth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat booking");
  const b = await Booking.findOneAndUpdate({ _id: req.params.id, user: req.user._id, status: { $in: ["Pending", "Confirmed"] } }, { status: "Cancelled" }, { new: true });
  b ? res.json(b) : bad(res, "Booking nahi mili", 404);
}));

/* ---------- cabin booking ---------- */
app.get("/api/cabins/availability", wrap(async (req, res) => {
  const date = str(req.query.date, 10);
  if (!D_OK.test(date) || date < today() || date > maxDate()) return bad(res, "Aaj se 30 din ke andar ki date chuno");
  const c = await cabinCfg(), rows = await Booking.find({ date, ...holdQ() });
  res.json({
    open: c.open, close: c.close, slot: c.slot, step: c.slot, rate: c.rate, advance: c.advance, nowMin: date === today() ? nowMin() : 0,
    cabins: c.cabins.map(x => ({ id: x.id, name: "Cabin " + x.id, active: x.active,
      busy: rows.filter(r => r.cabin === x.id || r.cabin === 0).map(r => ({ s: r.startMin, e: r.endMin })) }))
  });
}));
// Payment ke baad booking apne aap Confirmed ho jaati hai. Agar usi beech koi aur pehle confirm ho chuka ho, to Pending rehti hai (admin dekhega)
async function markBookingPaid(rzpOrderId, paymentId) {
  const b = await Booking.findOneAndUpdate({ rzpOrderId, paid: { $ne: true } }, { paid: true, payId: String(paymentId) }, { new: true });
  if (!b) return null;
  b.status = (await paidClash(b.date, b.cabin, b.startMin, b.endMin, b._id)) ? "Pending" : "Confirmed";
  await b.save();
  return b;
}

/* Step 1: cabin check karo, Razorpay par advance ka order banao */
app.post("/api/bookings/create", userAuth, limit(20, 600000), wrap(async (req, res) => {
  const date = str(req.body.date, 10), start = str(req.body.start, 5), hours = parseInt(req.body.hours),
    cabin = parseInt(req.body.cabin), note = str(req.body.note, 200);
  if (!D_OK.test(date) || date < today() || date > maxDate()) return bad(res, "Aaj se 30 din ke andar ki date chuno");
  if (!T_OK.test(start)) return bad(res, "Sahi time chuno");
  if (!(hours >= 1 && hours <= 4)) return bad(res, "1 se 4 ghante ke beech chuno");
  const c = await cabinCfg(), s = toMin(start), e = s + hours * 60;
  if (s < c.open || e > c.close || (s - c.open) % c.slot) return bad(res, "Ye time cabin ki timing ke bahar hai");
  if (date === today() && s < nowMin()) return bad(res, "Ye time nikal chuka hai");
  const cb = c.cabins.find(x => x.id === cabin);
  if (!cb || !cb.active) return bad(res, "Ye cabin abhi booking ke liye available nahi hai");
  if (await clash(date, cabin, s, e)) return bad(res, "Ye cabin is time par pehle se book hai, doosra cabin ya time chuno");
  const open = await Booking.countDocuments({ user: req.user._id, status: { $in: ["Pending", "Confirmed"] }, date: { $gte: today() } });
  if (open >= 5) return bad(res, "Aapki 5 active bookings pehle se hain");
  const total = c.rate * hours, advance = Math.min(c.advance, total);   // total aur advance hamesha server se
  const r = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(RAZORPAY_KEY_ID + ":" + RAZORPAY_KEY_SECRET).toString("base64") },
    body: JSON.stringify({ amount: advance * 100, currency: "INR", receipt: "CB" + Date.now().toString().slice(-8), notes: { cabin, date, start, hours } })
  });
  const rz = await r.json();
  if (!r.ok) { console.error("Razorpay error:", rz); return bad(res, "Payment shuru nahi ho paya, dobara try karo", 502); }
  await Booking.create({ user: req.user._id, name: req.user.name, phone: req.user.phone, cabin, date, start, end: hm(e),
    startMin: s, endMin: e, hours, total, advance, note, status: "Awaiting payment", paid: false, rzpOrderId: rz.id });
  res.json({ key: RAZORPAY_KEY_ID, orderId: rz.id, amount: rz.amount });
}));

/* Step 2: payment verify, tabhi booking admin ke paas confirm hone ke liye jaati hai */
app.post("/api/bookings/verify", limit(20, 600000), wrap(async (req, res) => {
  const oid = str(req.body.orderId, 40), pid = str(req.body.paymentId, 40), sig = str(req.body.signature, 128);
  const exp = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(oid + "|" + pid).digest("hex");
  if (!sigOk(sig, exp)) return bad(res, "Payment verify nahi hua");
  const b = (await markBookingPaid(oid, pid)) || (await Booking.findOne({ rzpOrderId: oid, paid: true }));
  if (!b) return bad(res, "Booking nahi mili", 404);
  res.json({ ok: true, status: b.status, cabin: b.cabin, date: b.date, start: b.start, end: b.end, total: b.total, advance: b.advance });
}));

/* ---------- admin API ---------- */
app.post("/api/admin/login", limit(8, 600000), (req, res) => {
  if (!eq(String(req.body.pin ?? ""), ADMIN_PIN)) return bad(res, "Galat PIN", 401);
  res.json({ token: jwt.sign({ r: "admin" }, JWT_SECRET, { expiresIn: "12h" }) });
});
const auth = (req, res, next) => {
  try { if (jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), JWT_SECRET).r !== "admin") throw 0; next(); }
  catch { bad(res, "Login expire ho gaya", 401); }
};
app.use("/api/admin", auth);

app.get("/api/admin/orders", wrap(async (q, r) => r.json(await Order.find({ paid: true }).sort({ createdAt: -1 }).limit(300))));
app.patch("/api/admin/orders/:id", wrap(async (req, res) => {
  const st = String(req.body.status);
  if (!["New", "Preparing", "Ready", "Done", "Cancelled"].includes(st)) return bad(res, "Galat status");
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat order");
  const o = await Order.findByIdAndUpdate(req.params.id, { status: st }, { new: true });
  o ? res.json(o) : bad(res, "Order nahi mila", 404);
}));
app.get("/api/admin/menu", wrap(async (q, r) => r.json((await Menu.find().sort({ category: 1, createdAt: 1 })).map(pub))));
function withImage(req, d) {
  if (req.body.image) { const im = readImg(req.body.image); if (!im) return false; Object.assign(d, im); }
  if (req.body.removeImage) Object.assign(d, { hasImage: false, imgData: null, imgMime: "" });
  return true;
}
const PHOTO_ERR = "Photo sahi nahi hai ya bahut badi hai (max 400 KB)";
app.post("/api/admin/menu", wrap(async (req, res) => {
  const d = cleanItem(req.body);
  if (!d.name || !(d.price > 0)) return bad(res, "Naam aur price zaroori hain");
  if (!withImage(req, d)) return bad(res, PHOTO_ERR);
  res.json(pub(await Menu.create(d)));
}));
app.put("/api/admin/menu/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat item");
  const d = cleanItem(req.body);
  if (!d.name || !(d.price > 0)) return bad(res, "Naam aur price zaroori hain");
  if (!withImage(req, d)) return bad(res, PHOTO_ERR);
  const m = await Menu.findByIdAndUpdate(req.params.id, d, { new: true });
  m ? res.json(pub(m)) : bad(res, "Item nahi mila", 404);
}));
app.delete("/api/admin/menu/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat item");
  await Menu.findByIdAndDelete(req.params.id); res.json({ ok: true });
}));
app.get("/api/admin/bookings", wrap(async (q, r) => r.json(await Booking.find({ status: { $ne: "Awaiting payment" } }).sort({ date: -1, startMin: 1 }).limit(400))));
app.patch("/api/admin/bookings/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat booking");
  const b = await Booking.findById(req.params.id);
  if (!b) return bad(res, "Booking nahi mili", 404);
  if (b.status === "Blocked") return bad(res, "Block ko remove karo");
  const st = req.body.status !== undefined ? String(req.body.status) : b.status,
    cab = req.body.cabin !== undefined ? parseInt(req.body.cabin) : b.cabin;
  if (!["Pending", "Confirmed", "Cancelled"].includes(st)) return bad(res, "Galat status");
  if (![1, 2, 3].includes(cab)) return bad(res, "Cabin 1, 2 ya 3 hona chahiye");
  if (st === "Confirmed" && await paidClash(b.date, cab, b.startMin, b.endMin, b._id))
    return bad(res, "Cabin " + cab + " is time par pehle se booked hai. Cabin badal kar confirm karo.");
  b.status = st; b.cabin = cab; await b.save();
  res.json(b);
}));
app.post("/api/admin/blocks", wrap(async (req, res) => {
  const date = str(req.body.date, 10), start = str(req.body.start, 5), end = str(req.body.end, 5),
    cabin = parseInt(req.body.cabin), reason = str(req.body.reason, 100);
  if (!D_OK.test(date)) return bad(res, "Date chuno");
  if (!T_OK.test(start) || !T_OK.test(end) || toMin(end) <= toMin(start)) return bad(res, "Sahi start aur end time chuno");
  if (![0, 1, 2, 3].includes(cabin)) return bad(res, "Galat cabin");
  res.json(await Booking.create({ name: "Blocked", cabin, date, start, end, startMin: toMin(start), endMin: toMin(end), reason, status: "Blocked" }));
}));
app.delete("/api/admin/bookings/:id", wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat booking");
  await Booking.findByIdAndDelete(req.params.id); res.json({ ok: true });
}));
app.get("/api/admin/users", wrap(async (q, r) => r.json(await User.find().sort({ createdAt: -1 }).limit(500).select("name phone createdAt lockUntil"))));
app.post("/api/admin/users/:id/pin", wrap(async (req, res) => {
  const pin = str(req.body.pin, 6);
  if (!pinOk(pin)) return bad(res, "PIN 4 se 6 digit ka hona chahiye");
  if (!mongoose.isValidObjectId(req.params.id)) return bad(res, "Galat customer");
  const salt = crypto.randomBytes(16).toString("hex");
  const u = await User.findByIdAndUpdate(req.params.id, { salt, hash: hashPin(pin, salt), fails: 0, lockUntil: null });
  u ? res.json({ ok: true }) : bad(res, "Customer nahi mila", 404);
}));
app.get("/api/admin/settings", wrap(async (q, r) => r.json(await getCfg())));
app.put("/api/admin/settings", wrap(async (req, res) => {
  const lim = { name: 60, upi: 60, heroTitle: 80, heroText: 300, storyTitle: 80, storyText: 500, hours: 100, address: 200, phone: 30,
    cabinOpen: 5, cabinClose: 5, cabinSlot: 3, cabinRate: 6, cabinAdvance: 6, cab1: 1, cab2: 1, cab3: 1 };
  const out = {};
  for (const k in lim) if (req.body[k] !== undefined) out[k] = str(req.body[k], lim[k]);
  if ("name" in out && !out.name) out.name = CAFE_NAME;
  if ("heroTitle" in out && !out.heroTitle) out.heroTitle = DEF.heroTitle;
  if (out.upi && !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(out.upi)) return bad(res, "Sahi UPI ID daalo, jaise naam@upi");
  for (const k of ["cabinOpen", "cabinClose"]) if (k in out && !T_OK.test(out[k])) return bad(res, "Sahi time chuno");
  if ("cabinSlot" in out && ![30, 60, 90, 120].includes(+out.cabinSlot)) return bad(res, "Slot 30, 60, 90 ya 120 minute ka hona chahiye");
  for (const k of ["cab1", "cab2", "cab3"]) if (k in out && !["0", "1"].includes(out[k])) return bad(res, "Galat cabin setting");
  for (const k of ["cabinRate", "cabinAdvance"]) if (k in out) { const n = parseInt(out[k]); if (!(n >= 1 && n <= 100000 && String(n) === out[k])) return bad(res, "Amount sahi daalo, jaise 300"); }
  const cur = await getCfg();
  if (+(out.cabinAdvance ?? cur.cabinAdvance) > +(out.cabinRate ?? cur.cabinRate)) return bad(res, "Advance ek ghante ke charge se zyada nahi ho sakta");
  if (toMin(out.cabinOpen ?? cur.cabinOpen) >= toMin(out.cabinClose ?? cur.cabinClose)) return bad(res, "Closing time opening ke baad ka hona chahiye");
  for (const k in out) await Setting.findOneAndUpdate({ key: k }, { value: out[k] }, { upsert: true });
  res.json(await getCfg());
}));

/* ---------- start ---------- */
const seed = [
  ["Marigold Latte", "Coffee", 180, "☕", "Espresso, steamed milk, saffron and a touch of jaggery."],
  ["Cold Brew Tonic", "Coffee", 210, "🧊", "Twelve-hour cold brew over sparkling tonic and orange peel."],
  ["Kulhad Filter Coffee", "Coffee", 120, "🫖", "South Indian filter decoction, poured into a clay kulhad."],
  ["Rose Matcha", "Tea", 230, "🍵", "Ceremonial matcha whisked with rose milk."],
  ["Masala Chai", "Tea", 90, "🫚", "Slow-simmered with ginger, cardamom and black pepper."],
  ["Butter Croissant", "Bakes", 140, "🥐", "Baked every morning, 27 layers of butter."],
  ["Basque Cheesecake", "Bakes", 260, "🍰", "Burnt top, creamy centre, berry compote."],
  ["Paneer Tikka Sandwich", "Bites", 190, "🥪", "Grilled sourdough, smoky paneer, mint chutney."],
  ["Peri Peri Fries", "Bites", 150, "🍟", "Crisp fries tossed in house peri peri."]
].map(([name, category, price, emoji, description]) => ({ name, category, price, emoji, description }));

mongoose.connect(MONGODB_URI).then(async () => {
  if (!(await Menu.countDocuments())) await Menu.insertMany(seed);
  app.listen(PORT, () => console.log("Server chal raha hai, port " + PORT));
}).catch(e => { console.error("MongoDB connect nahi hua:", e.message); process.exit(1); });
