// ======= DOM =======
const emailEl = document.getElementById('email');
const passEl = document.getElementById('password');
const signupBtn = document.getElementById('signup');
const loginBtn = document.getElementById('login');
const logoutBtn = document.getElementById('logout');
const whenOut = document.getElementById('when-logged-out');
const whenIn = document.getElementById('when-logged-in');
const userEmail = document.getElementById('user-email');
const balanceEl = document.getElementById('balance');
const historyEl = document.getElementById('history');
const spinBtn = document.getElementById('spin');
const resultText = document.getElementById('result');
const spinCostEl = document.getElementById('spin-cost');
const minWithdrawEl = document.getElementById('min-withdraw');
const topupAmount = document.getElementById('topup-amount');
const providerSel = document.getElementById('provider');
const addBalanceBtn = document.getElementById('add-balance');
const withdrawBtn = document.getElementById('withdraw-btn');
const withdrawAmount = document.getElementById('withdraw-amount');
const withdrawProvider = document.getElementById('withdraw-provider');
const withdrawName = document.getElementById('withdraw-name');
const withdrawPhone = document.getElementById('withdraw-phone');

// Wheel
const wheel = document.getElementById('wheel');
const ctx = wheel.getContext('2d');
let startAngle = 0;
let PRIZES = [];
const COLORS = ['#ff6b6b','#4ecdc4','#45b7d1','#f7d794','#a29bfe','#fd79a8','#55efc4','#ffeaa7'];

// ======= Helpers =======
function drawWheel(){
  if (!PRIZES.length) return;
  const cx=260, cy=260, r=250; // canvas 520
  const arc = Math.PI * 2 / PRIZES.length;
  ctx.clearRect(0,0,wheel.width,wheel.height);
  for(let i=0;i<PRIZES.length;i++){
    const angle = startAngle + i*arc;
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,angle,angle+arc);
    ctx.closePath();
    ctx.fillStyle = COLORS[i%COLORS.length];
    ctx.fill();

    ctx.save();
    ctx.translate(cx + Math.cos(angle+arc/2)*170, cy + Math.sin(angle+arc/2)*170);
    ctx.rotate(angle+arc/2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px system-ui';
    const text = PRIZES[i];
    ctx.fillText(text, -ctx.measureText(text).width/2, 0);
    ctx.restore();
  }
  // pointer
  ctx.fillStyle = 'red';
  ctx.beginPath();
  ctx.moveTo(cx-12, cy-r+10);
  ctx.lineTo(cx+12, cy-r+10);
  ctx.lineTo(cx, cy-r+50);
  ctx.closePath();
  ctx.fill();
}

function easeOut(t, b, c, d){ const ts=(t/=d)*t, tc=ts*t; return b + c*(tc + -3*ts + 3*t); }

async function animateToIndex(index){
  const total = PRIZES.length; const arc = Math.PI*2/total;
  const targetAngle = (Math.PI/2) - (index*arc + arc/2);
  const spins = Math.PI*2 * (Math.random()*2 + 5);
  const finalAngle = targetAngle + spins;
  const duration = 3500 + Math.random()*1000;
  let start=null; return new Promise(resolve=>{
    function step(ts){ if(!start) start=ts; const t=ts-start; const inc=easeOut(t,0,finalAngle-startAngle,duration);
      startAngle += inc; drawWheel(); if(t<duration) requestAnimationFrame(step); else { startAngle = finalAngle; drawWheel(); resolve(); } }
    requestAnimationFrame(step);
  });
}

// ======= Auth =======
signupBtn.onclick = async ()=>{ await auth.createUserWithEmailAndPassword(emailEl.value, passEl.value); };
loginBtn.onclick  = async ()=>{ await auth.signInWithEmailAndPassword(emailEl.value, passEl.value); };
logoutBtn.onclick = ()=> auth.signOut();

auth.onAuthStateChanged(async (user)=>{
  if(user){
    whenOut.classList.add('hidden');
    whenIn.classList.remove('hidden');
    userEmail.textContent = user.email;

    // live balance + history
    db.collection('users').doc(user.uid).onSnapshot((doc)=>{
      const data = doc.data() || { balance: 0 };
      balanceEl.textContent = `₱${(data.balance||0).toFixed(2)}`;
      const hist = (data.spins||[]).slice(-10).reverse();
      historyEl.innerHTML = hist.map(s=>`<li>${new Date(s.date.seconds? s.date.seconds*1000 : s.date).toLocaleString()} — ${s.result||s.prize} (₱${s.cost||0})</li>`).join('');
    });
  } else {
    whenOut.classList.remove('hidden');
    whenIn.classList.add('hidden');
    userEmail.textContent = '';
    balanceEl.textContent = '₱0';
    historyEl.innerHTML='';
  }
});

// ======= Load server config (prizes/costs) =======
(async function loadConfig(){
  try{
    const getConfig = firebase.functions().httpsCallable('getConfig');
    const { data } = await getConfig();
    PRIZES = data.prizes.map(p=>p.label);
    spinCostEl.textContent = `₱${data.spinCost}`;
    minWithdrawEl.textContent = `${data.minWithdraw}`;
    drawWheel();
  }catch(e){ console.error('Failed to load config', e); }
})();

// ======= Top-up =======
addBalanceBtn.onclick = async ()=>{
  const user = auth.currentUser; if(!user) return alert('Please log in.');
  const amount = Math.max(10, Number(topupAmount.value||0));
  const provider = providerSel.value;
  const res = await fetch(`/api/createCheckout`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ amount, provider, uid: user.uid, successUrl: window.location.origin+"/index.html?topup=success", failUrl: window.location.origin+"/index.html?topup=failed" })
  });
  const data = await res.json();
  if(data.url){ window.location.href = data.url; } else alert(data.error||'Failed to create payment link.');
};

// ======= Spin (server authoritative) =======
let spinning = false;
spinBtn.onclick = async ()=>{
  const user = auth.currentUser; if(!user) return alert('Please log in.');
  if(spinning) return; spinning = true;
  try{
    const spinCallable = firebase.functions().httpsCallable('spin');
    const { data } = await spinCallable();
    await animateToIndex(data.resultIndex);
    resultText.textContent = `🎉 Prize: ${data.prize} ${data.prizeAmount>0?`(₱${data.prizeAmount})`:''}`;
  }catch(e){ alert(e.message); }
  finally{ spinning = false; }
};

// ======= Withdraw =======
withdrawBtn.onclick = async ()=>{
  const user = auth.currentUser; if(!user) return alert('Please log in.');
  const amount = Number(withdrawAmount.value||0);
  const provider = withdrawProvider.value;
  const name = withdrawName.value.trim();
  const phone = withdrawPhone.value.trim();
  if(!name || !phone) return alert('Enter account name and mobile number.');
  try{
    const call = firebase.functions().httpsCallable('withdraw');
    const { data } = await call({ amount, provider, name, phone });
    alert(`Withdrawal requested. TxID: ${data.txid || 'TBD'}`);
  }catch(e){ alert(e.message); }
};