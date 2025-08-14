
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const paymongoSecret = functions.config().paymongo?.secret;

admin.initializeApp();
const db = admin.firestore();

// ---- Game Config ----
const SPIN_COST = 10; // pesos
const MIN_WITHDRAW = 500; // pesos
// Ordered list defines wheel order
const PRIZES = [
  { label: '₱10', amount: 10, weight: 50 },
  { label: '₱50', amount: 50, weight: 30 },
  { label: '₱100', amount: 100, weight: 15 },
  { label: '₱500', amount: 500, weight: 5 },
  { label: 'Try Again', amount: 0, weight: 60 }
];

function pickWeightedPrize() {
  const total = PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (let i = 0; i < PRIZES.length; i++) {
    const p = PRIZES[i];
    if (r < p.weight) return { prize: p, index: i };
    r -= p.weight;
  }
  return { prize: PRIZES[0], index: 0 }; // fallback
}

// ---- Express app for REST endpoints (payments/webhooks) ----
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ENV (set with: firebase functions:config:set maya.secret="sk_test_xxx" maya.merchantid="YOUR_MERCHANT_ID" )
const mayaSecret = process.env.MAYA_SECRET || (functions.config().maya && functions.config().maya.secret);
const mayaMerchantId = process.env.MAYA_MERCHANTID || (functions.config().maya && functions.config().maya.merchantid);

// Create checkout (Maya or GCash via aggregator)
app.post('/api/createCheckout', async (req, res) => {
  try {
    const { amount, provider, uid, successUrl, failUrl } = req.body;
    if (!uid || !amount) return res.status(400).json({ error: 'Missing uid/amount' });

    if (provider === 'maya') {
      const id = 'topup_' + Date.now();
      const payload = {
        totalAmount: { value: amount, currency: 'PHP' },
        requestReferenceNumber: id,
        redirectUrl: { success: successUrl, failure: failUrl, cancel: failUrl },
        metadata: { uid }
      };
      const url = 'https://pg-sandbox.paymaya.com/checkout/v1/checkouts';
      const resp = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + Buffer.from(mayaSecret + ':').toString('base64') }
      });
      return res.json({ url: resp.data.redirectUrl });
    }

    if (provider === 'gcash') {
      // TODO: Use your aggregator API to create a GCash payment session
      return res.status(501).json({ error: 'GCash aggregator not configured' });
    }

    return res.status(400).json({ error: 'Unknown provider' });
  } catch (e) {
    console.error(e.response?.data || e.message);
    return res.status(500).json({ error: 'Failed to create checkout' });
  }
});

// Maya Webhook: confirm payment -> credit wallet
app.post('/api/webhooks/maya', async (req, res) => {
  try {
    // TODO: Verify Maya webhook signature per docs using req.rawBody and headers
    const event = req.body;
    if (event?.paymentStatus === 'PAYMENT_SUCCESS' || event?.status === 'SUCCESS') {
      const amount = Number(event.totalAmount?.value || event.amount || 0);
      const uid = event.metadata?.uid;
      if (uid && amount > 0) {
        await db.runTransaction(async (tx) => {
          const ref = db.collection('users').doc(uid);
          const snap = await tx.get(ref);
          const cur = (snap.exists && snap.data().balance) || 0;
          tx.set(ref, { balance: cur + amount }, { merge: true });
          tx.set(ref.collection('wallet_logs').doc(), {
            type: 'topup', amount, at: admin.firestore.FieldValue.serverTimestamp(), provider: 'maya', ref: event.requestReferenceNumber || event.id
          });
        });
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error', e);
    res.sendStatus(400);
  }
});

// ---- Callable: get config for client (prize labels + costs) ----
exports.getConfig = functions.https.onCall(async (_data, _ctx) => {
  return {
    prizes: PRIZES.map(p => ({ label: p.label })),
    spinCost: SPIN_COST,
    minWithdraw: MIN_WITHDRAW
  };
});

// ---- Callable: spin (atomic balance deduction + prize credit) ----
exports.spin = functions.https.onCall(async (_data, context) => {
  const uid = context.auth?.uid; if(!uid) throw new functions.https.HttpsError('unauthenticated','Login required');

  const result = await db.runTransaction(async (tx)=>{
    const ref = db.collection('users').doc(uid);
    const snap = await tx.get(ref);
    const balance = (snap.exists && snap.data().balance) || 0;
    if (balance < SPIN_COST) throw new functions.https.HttpsError('failed-precondition','Insufficient balance');

    // Deduct cost
    tx.set(ref, { balance: balance - SPIN_COST }, { merge: true });

    // Pick weighted prize
    const picked = pickWeightedPrize();
    const prize = picked.prize; const index = picked.index;

    // If monetary, credit it
    if (prize.amount > 0) {
      tx.set(ref, { balance: balance - SPIN_COST + prize.amount }, { merge: true });
    }

    // Logs
    const logRef = ref.collection('spins').doc();
    tx.set(logRef, { at: admin.firestore.FieldValue.serverTimestamp(), result: prize.label, amount: prize.amount, cost: SPIN_COST });

    const arr = (snap.exists && snap.data().spins) || [];
    arr.push({ date: Date.now(), result: prize.label, amount: prize.amount, cost: SPIN_COST });
    const trimmed = arr.slice(-20);
    tx.set(ref, { spins: trimmed }, { merge: true });

    return { prize, index };
  });

  return { prize: result.prize.label, prizeAmount: result.prize.amount, resultIndex: result.index };
});

// ---- Callable: withdraw (>= MIN_WITHDRAW) ----
exports.withdraw = functions.https.onCall(async (data, context) => {
  const uid = context.auth?.uid; if(!uid) throw new functions.https.HttpsError('unauthenticated','Login required');
  const amount = Number(data.amount||0);
  const provider = String(data.provider||'');
  const name = String(data.name||'').trim();
  const phone = String(data.phone||'').trim();

  if (isNaN(amount) || amount <= 0) throw new functions.https.HttpsError('invalid-argument','Invalid amount');
  if (amount < MIN_WITHDRAW) throw new functions.https.HttpsError('failed-precondition', `Minimum withdrawal is ₱${MIN_WITHDRAW}`);
  if (!name || !phone) throw new functions.https.HttpsError('invalid-argument','Name and phone are required');

  return await db.runTransaction(async (tx)=>{
    const ref = db.collection('users').doc(uid);
    const snap = await tx.get(ref);
    const balance = (snap.exists && snap.data().balance) || 0;
    if (balance < amount) throw new functions.https.HttpsError('failed-precondition','Insufficient balance');

    // --- Replace this with real provider payout call ---
    const payout = await mockSendPayout({ amount, provider, name, phone, uid });
    if (!payout.success) throw new functions.https.HttpsError('internal','Payout failed');

    // Deduct and log
    tx.set(ref, { balance: balance - amount }, { merge: true });
    tx.set(ref.collection('wallet_logs').doc(), {
      type: 'withdraw', amount, at: admin.firestore.FieldValue.serverTimestamp(), provider, ref: payout.txid, to: phone, name
    });

    return { txid: payout.txid };
  });
});

async function mockSendPayout({ amount, provider, name, phone }){
  console.log(`[MOCK PAYOUT] ₱${amount} via ${provider} to ${name} (${phone})`);
  // Simulate success
  await new Promise(r=>setTimeout(r, 300));
  return { success: true, txid: `MOCK-${Date.now()}` };
}


async function sendPayout({ amount, provider, name, phone }) {
  const cents = amount * 100;
  const payload = {
    type: "disbursement",
    amount: cents,
    currency: "PHP",
    channel: provider === 'gcash' ? 'gcash' : 'maya',
    recipient: {
      name,
      phone_number: phone
    },
    description: `Withdrawal for user`
  };
  const resp = await axios.post("https://api.paymongo.com/v1/disbursements", payload, {
    headers: {
      Authorization: `Basic ${Buffer.from(paymongoSecret + ':').toString('base64')}`,
      'Content-Type': 'application/json'
    }
  });
  return { success: true, txid: resp.data.data.id };
}

// Export Express API for hosting rewrites
exports.api = functions.https.onRequest(app);
