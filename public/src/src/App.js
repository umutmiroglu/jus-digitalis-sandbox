import { useState, useEffect, useRef } from "react";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const INITIAL_COINS = 1000;
const ORACLE_FEE = 30;

// Dava süreci: 3 aşama, her aşama ~4s (toplam ~12s simüle edilmiş "yıllar")
const LAWSUIT_YEARS = [
  { year: 1, label: "1. YIL",  events: ["Dilekçeler hazırlandı.", "Tebligatlar gönderildi.", "İlk duruşma tarihi bekleniyor..."] },
  { year: 2, label: "2. YIL",  events: ["Bilirkişi raporu istendi.", "Karşı taraf rapora itiraz etti.", "Ek süre tanındı..."] },
  { year: 3, label: "3. YIL",  events: ["Karar duruşması yapıldı.", "Yargıtay sürecine taşındı.", "İlam kesinleşti."] },
];

// Enflasyon çarpanı: yıl başına %20 değer kaybı
// 1. yılda kazan → %75 reel değer  |  2. yılda → %55  |  3. yılda → %40
const INFLATION_BY_YEAR = { 1: 0.75, 2: 0.55, 3: 0.40 };

// Dürüst botun başarısızlık nedenleri (force majeure / tasfiye)
const HONEST_FAILURE_REASONS = [
  "Beklenmedik ekonomik kriz nedeniyle şirket faaliyetlerini durdurdu.",
  "Dürüst Satıcı'nın tedarik zinciri çöktü — force majeure koşulları oluştu.",
  "Şirket tasfiyeye (Liquidation) girdi. Alacaklar sıraya alındı.",
  "Regülasyon değişikliği tedariki imkansız kıldı. Sözleşme ifa edilemedi.",
];

const BOTS = [
  {
    id: "honest",
    name: "Dürüst Satıcı",
    title: "Güvenilir Tüccar",
    emoji: "🤝",
    color: "#00d4aa",
    colorRgb: "0,212,170",
    risk: "Düşük Risk",
    riskColor: "#00d4aa",
    basePrice: 200,
    reward: 320,
    baseSuccessRate: 0.87,       // ← v2.1: artık yanılabilir
    delay: 1800,
    catchphrase: "Söz verdiysem yerine getiririm.",
    description: "Niyeti daima dürüst. Ancak ekonomik krizler ve tasfiyeler onu da etkileyebilir.",
    riskTolerance: 0.9,
    priceFlexibility: 0.05,
    failureType: "force_majeure", // özel başarısızlık türü
  },
  {
    id: "opportunist",
    name: "Fırsatçı Freelancer",
    title: "Bağımsız Ajan",
    emoji: "🦊",
    color: "#ff6b35",
    colorRgb: "255,107,53",
    risk: "Yüksek Risk",
    riskColor: "#ff4444",
    basePrice: 150,
    reward: 380,
    baseSuccessRate: 0.28,
    delay: 2800,
    catchphrase: "Fiyat uygunsa... görüşürüz.",
    description: "Sözleşmede açık bulursa teslimatı geçirir. Ama bedeli cazip...",
    riskTolerance: 0.3,
    priceFlexibility: 0.25,
    failureType: "fraud",
  },
  {
    id: "contractor",
    name: "Uzman Müteahhit",
    title: "Proje Yöneticisi",
    emoji: "🏗️",
    color: "#3b82f6",
    colorRgb: "59,130,246",
    risk: "Orta Risk",
    riskColor: "#f39c12",
    basePrice: 250,
    reward: 420,
    baseSuccessRate: 0.65,
    delay: 2200,
    catchphrase: "Proje teslim edilir — ama zamanlaması değişebilir.",
    description: "Büyük işler alır. Çoğunlukla teslim eder ama gecikme riski yüksek.",
    riskTolerance: 0.5,
    priceFlexibility: 0.15,
    failureType: "delay",
  },
];

// ─── UTILS ────────────────────────────────────────────────────────────────────

function genContractId() {
  return "JD-" + Math.random().toString(36).toUpperCase().slice(2, 8) +
    "-" + Date.now().toString(36).toUpperCase().slice(-4);
}

function nowStr() { return new Date().toLocaleString("tr-TR"); }

function getSessionTime(startTime) {
  const s = Math.floor((Date.now() - startTime) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function botEvaluateContract(bot, params) {
  const harshness = (1 - params.timeout / 60) * 0.5 + (params.penaltyRate / 100) * 0.5;
  if (harshness > bot.riskTolerance + 0.4)
    return { refused: true, priceMultiplier: 1, reason: "Şartlar çok sert — bot sözleşmeyi imzalamayı reddetti." };
  if (harshness > bot.riskTolerance) {
    const bump = 1 + bot.priceFlexibility + (harshness - bot.riskTolerance) * 0.5;
    return { refused: false, priceMultiplier: parseFloat(bump.toFixed(2)), reason: `Bot sözleşmeyi riskli buldu ve fiyatı %${Math.round((bump - 1) * 100)} artırdı.` };
  }
  return { refused: false, priceMultiplier: 1, reason: null };
}

function computeSuccessRate(bot, params) {
  let rate = bot.baseSuccessRate;
  if (params.useOracle) rate = Math.min(rate + 0.4, 0.99);
  if (bot.id === "opportunist" && params.timeout < 15) rate = Math.max(rate - 0.1, 0);
  return rate;
}

// Enflasyon erozyonu hesapla: kazanma yılına göre reel değer
function computeInflatedRefund(nominalAmount, yearWon) {
  const multiplier = INFLATION_BY_YEAR[yearWon] || 0.40;
  return { reel: Math.floor(nominalAmount * multiplier), multiplier, yearWon };
}

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Syne:wght@600;700;800;900&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Syne', sans-serif; background: #080c14; }

  @keyframes spin       { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes pulse      { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1.2)} }
  @keyframes fadeUp     { 0%{opacity:1;transform:translateY(0)} 100%{opacity:0;transform:translateY(-28px)} }
  @keyframes scanline   { 0%{transform:translateY(-100%)} 100%{transform:translateY(100vh)} }
  @keyframes lockPulse  { 0%,100%{box-shadow:0 0 20px rgba(0,212,170,.3)} 50%{box-shadow:0 0 50px rgba(0,212,170,.8),0 0 80px rgba(0,212,170,.3)} }
  @keyframes coinRain   { 0%{transform:translateY(-20px) rotate(0deg);opacity:1} 100%{transform:translateY(80px) rotate(720deg);opacity:0} }
  @keyframes shakeX     { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-8px)} 40%,80%{transform:translateX(8px)} }
  @keyframes float      { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
  @keyframes countUp    { from{opacity:0;transform:scale(.5)} to{opacity:1;transform:scale(1)} }
  @keyframes receiptIn  { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
  @keyframes yearSlide  { from{opacity:0;transform:translateX(-16px)} to{opacity:1;transform:translateX(0)} }
  @keyframes erode      { 0%{width:100%} 100%{width:var(--target-w)} }
  @keyframes redPulse   { 0%,100%{box-shadow:0 0 12px rgba(255,68,68,.2)} 50%{box-shadow:0 0 30px rgba(255,68,68,.6)} }
  @keyframes greenFlash { 0%{background:rgba(0,212,170,.3)} 100%{background:transparent} }

  input[type=range] { -webkit-appearance:none; appearance:none; height:4px; border-radius:2px; outline:none; cursor:pointer; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:16px; height:16px; border-radius:50%; cursor:pointer; }
  ::-webkit-scrollbar { width:4px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:rgba(0,212,170,.3); border-radius:2px; }
`;

// ─── BACKGROUND ───────────────────────────────────────────────────────────────

function CityGrid() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, background: "linear-gradient(180deg,#080c14 0%,#0a0f1c 60%,#080c14 100%)", overflow: "hidden" }}>
      <svg width="100%" height="100%" style={{ position: "absolute", opacity: 0.05 }}>
        <defs><pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
          <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#00d4aa" strokeWidth="0.5" />
        </pattern></defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>
      <div style={{ position:"absolute", top:"15%", left:"10%", width:500, height:500, borderRadius:"50%", background:"radial-gradient(circle,rgba(0,212,170,.07) 0%,transparent 70%)", filter:"blur(50px)" }} />
      <div style={{ position:"absolute", bottom:"20%", right:"5%", width:600, height:600, borderRadius:"50%", background:"radial-gradient(circle,rgba(59,130,246,.06) 0%,transparent 70%)", filter:"blur(60px)" }} />
      <div style={{ position:"absolute", top:"55%", left:"35%", width:350, height:350, borderRadius:"50%", background:"radial-gradient(circle,rgba(255,107,53,.05) 0%,transparent 70%)", filter:"blur(50px)" }} />
    </div>
  );
}

// ─── TICKER ───────────────────────────────────────────────────────────────────

function Ticker({ logs }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs]);
  return (
    <div ref={ref} style={{ height:110, overflowY:"auto", padding:"10px 14px", background:"rgba(0,0,0,.55)", borderRadius:10, border:"1px solid rgba(0,212,170,.18)", fontFamily:"'Space Mono',monospace", fontSize:11, scrollbarWidth:"none" }}>
      {logs.length === 0 && <div style={{ color:"rgba(0,212,170,.35)" }}>// Sistem bekleniyor...</div>}
      {logs.map((l, i) => (
        <div key={i} style={{ color:l.color||"#00d4aa", marginBottom:3, lineHeight:1.6 }}>
          <span style={{ color:"rgba(255,255,255,.25)" }}>[{l.time}]</span> {l.msg}
        </div>
      ))}
    </div>
  );
}

// ─── COIN DISPLAY ─────────────────────────────────────────────────────────────

function CoinDisplay({ coins, change }) {
  const [flash, setFlash] = useState(false);
  const [dir, setDir] = useState(0);
  const [particles, setParticles] = useState([]);

  useEffect(() => {
    if (change !== 0) {
      setFlash(true); setDir(change);
      if (change > 0) {
        setParticles(Array.from({ length:6 }, (_,i) => ({ id:Date.now()+i, x:Math.random()*60-30 })));
        setTimeout(() => setParticles([]), 1000);
      }
      setTimeout(() => { setFlash(false); setDir(0); }, 900);
    }
  }, [change]);

  return (
    <div style={{
      display:"flex", alignItems:"center", gap:14, position:"relative",
      background: flash ? (dir>0 ? "rgba(0,212,170,.15)" : "rgba(255,68,68,.15)") : "rgba(0,0,0,.45)",
      border:`1px solid ${flash ? (dir>0 ? "#00d4aa" : "#ff4444") : "rgba(255,255,255,.1)"}`,
      borderRadius:14, padding:"12px 22px",
      transition:"all .35s cubic-bezier(.4,0,.2,1)",
      animation: flash&&dir<0 ? "shakeX .5s ease" : "none",
    }}>
      <div style={{ position:"relative" }}>
        <span style={{ fontSize:26, animation:"float 3s ease-in-out infinite", display:"block" }}>🪙</span>
        {particles.map(p => (
          <span key={p.id} style={{ position:"absolute", top:0, left:`calc(50% + ${p.x}px)`, fontSize:12, animation:"coinRain .9s ease-out forwards", pointerEvents:"none" }}>🪙</span>
        ))}
      </div>
      <div>
        <div style={{ color:"rgba(255,255,255,.4)", fontSize:9, letterSpacing:2.5, textTransform:"uppercase", marginBottom:2 }}>JusCoin Bakiyesi</div>
        <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
          <span style={{ color:"#fff", fontSize:26, fontWeight:900, fontFamily:"'Space Mono',monospace", letterSpacing:-0.5 }}>{coins.toLocaleString()}</span>
          {flash && dir!==0 && (
            <span style={{ fontSize:15, fontWeight:800, color:dir>0?"#00d4aa":"#ff4444", animation:"fadeUp .85s forwards", fontFamily:"'Space Mono',monospace" }}>
              {dir>0?"+":""}{dir}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SLIDER ───────────────────────────────────────────────────────────────────

function SliderParam({ label, sublabel, value, min, max, step=1, onChange, unit="", color="#00d4aa" }) {
  const pct = ((value-min)/(max-min))*100;
  return (
    <div style={{ marginBottom:18 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:6 }}>
        <div>
          <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>{label}</span>
          {sublabel && <span style={{ color:"rgba(255,255,255,.35)", fontSize:11, marginLeft:8 }}>{sublabel}</span>}
        </div>
        <span style={{ color, fontWeight:900, fontSize:16, fontFamily:"'Space Mono',monospace" }}>{value}{unit}</span>
      </div>
      <div style={{ position:"relative" }}>
        <div style={{ height:4, borderRadius:2, background:"rgba(255,255,255,.08)", position:"absolute", top:6, left:0, right:0 }} />
        <div style={{ height:4, borderRadius:2, background:`linear-gradient(90deg,${color}88,${color})`, position:"absolute", top:6, left:0, width:`${pct}%`, transition:"width .1s" }} />
        <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))} style={{ width:"100%", position:"relative", zIndex:2, background:"transparent", accentColor:color }} />
      </div>
    </div>
  );
}

// ─── DIGITAL VAULT ────────────────────────────────────────────────────────────

function DigitalVault({ amount, phase, color="#00d4aa" }) {
  const locked   = phase === "waiting";
  const released = phase === "released";
  const refunded = phase === "refunded";
  const borderColor = locked ? color : released ? "#f39c12" : refunded ? "#00d4aa" : "rgba(255,255,255,.1)";

  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:10, padding:"16px 0" }}>
      <div style={{
        width:100, height:100, borderRadius:20,
        background:"linear-gradient(145deg,#0f1c2e,#0a1220)",
        border:`2px solid ${borderColor}`,
        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
        position:"relative", overflow:"hidden",
        animation: locked ? "lockPulse 2s ease-in-out infinite" : "none",
        transition:"border-color .5s, box-shadow .5s",
        boxShadow: locked ? `0 0 30px ${color}44` : "none",
      }}>
        <div style={{ fontSize:36, lineHeight:1, filter:locked?`drop-shadow(0 0 8px ${color})`:"none", transition:"filter .3s" }}>
          {refunded ? "🔓" : released ? "💸" : "🔐"}
        </div>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:locked?color:"rgba(255,255,255,.4)", fontWeight:700, marginTop:4 }}>🪙 {amount}</div>
        {locked && (
          <div style={{ position:"absolute", inset:0, background:`linear-gradient(180deg,transparent 40%,${color}18 50%,transparent 60%)`, animation:"scanline 1.5s linear infinite" }} />
        )}
      </div>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:11, fontWeight:800, letterSpacing:1.5, textTransform:"uppercase", color:borderColor }}>
          {locked?"KİLİTLİ · GÜVENLİ" : released?"ÖDEME YAPILDI" : refunded?"OTOMATİK İADE":"BEKLEMEDE"}
        </div>
        <div style={{ fontSize:10, color:"rgba(255,255,255,.3)", marginTop:2 }}>
          {locked?"Bot teslim edene kadar para burada" : released?"Teslimat doğrulandı" : refunded?"Para anında tam değeriyle döndü":""}
        </div>
      </div>
      {locked && (
        <div style={{ display:"flex", gap:6 }}>
          {[0,1,2,3].map(i=>(<div key={i} style={{ width:6, height:6, borderRadius:"50%", background:color, animation:`pulse 1.4s ${i*.35}s infinite` }} />))}
        </div>
      )}
    </div>
  );
}

// ─── ZAMAN TÜNELİ ────────────────────────────────────────────────────────────

function TimeTunnel({ currentYear, currentEventIdx, won, finalData, onDone }) {
  const done = currentYear > 3;

  return (
    <div style={{ padding:"8px 0" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
        <div style={{ fontSize:28, animation:done?"none":"float 2s ease-in-out infinite" }}>⚖️</div>
        <div>
          <div style={{ color:"#f39c12", fontWeight:900, fontSize:16 }}>Hukuki Süreç — Zaman Tüneli</div>
          <div style={{ color:"rgba(255,255,255,.4)", fontSize:11, marginTop:2 }}>Her aşama gerçek hayatta bir yıl sürer.</div>
        </div>
      </div>

      {/* Year timeline */}
      <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:20 }}>
        {LAWSUIT_YEARS.map((y) => {
          const isActive  = y.year === currentYear && !done;
          const isPast    = y.year < currentYear || done;
          const isFuture  = y.year > currentYear && !done;

          return (
            <div key={y.year} style={{
              background: isPast ? "rgba(243,156,18,.06)" : isActive ? "rgba(243,156,18,.1)" : "rgba(255,255,255,.02)",
              border: `1px solid ${isActive ? "rgba(243,156,18,.5)" : isPast ? "rgba(243,156,18,.2)" : "rgba(255,255,255,.05)"}`,
              borderRadius:12, padding:"12px 16px",
              transition:"all .4s",
              opacity: isFuture ? 0.4 : 1,
            }}>
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: isActive ? 8 : 4 }}>
                <div style={{
                  width:28, height:28, borderRadius:"50%", flexShrink:0,
                  background: isPast ? (won ? "rgba(0,212,170,.2)" : "rgba(255,68,68,.2)") : isActive ? "rgba(243,156,18,.2)" : "rgba(255,255,255,.05)",
                  border: `2px solid ${isPast ? (won ? "#00d4aa" : "#ff4444") : isActive ? "#f39c12" : "rgba(255,255,255,.1)"}`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:12, fontWeight:900, color: isPast?(won?"#00d4aa":"#ff4444"):isActive?"#f39c12":"rgba(255,255,255,.3)",
                }}>
                  {isPast ? (won ? "✓" : "✗") : y.year}
                </div>
                <div>
                  <div style={{ color:isActive?"#f39c12":isPast?"rgba(255,255,255,.6)":"rgba(255,255,255,.3)", fontWeight:800, fontSize:13 }}>{y.label}</div>
                  {isActive && currentEventIdx >= 0 && (
                    <div style={{ color:"rgba(255,255,255,.5)", fontSize:11, animation:"yearSlide .4s ease-out" }}>
                      {y.events[currentEventIdx]}
                    </div>
                  )}
                  {isPast && (
                    <div style={{ color:"rgba(255,255,255,.3)", fontSize:11 }}>{y.events[y.events.length-1]}</div>
                  )}
                </div>
              </div>

              {/* Progress bar for active year */}
              {isActive && (
                <div style={{ marginLeft:38, height:3, background:"rgba(255,255,255,.06)", borderRadius:2, overflow:"hidden" }}>
                  <div style={{
                    height:"100%", background:"#f39c12", borderRadius:2,
                    width:`${((currentEventIdx+1)/LAWSUIT_YEARS[0].events.length)*100}%`,
                    transition:"width .8s ease-out",
                  }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Final verdict */}
      {done && finalData && (
        <div style={{ animation:"receiptIn .5s ease-out" }}>
          {won ? (
            <div style={{ background:"rgba(0,212,170,.07)", border:"1px solid rgba(0,212,170,.3)", borderRadius:14, padding:"16px 18px", marginBottom:16 }}>
              <div style={{ color:"#00d4aa", fontWeight:900, fontSize:16, marginBottom:8 }}>🏛️ Mahkeme Kararı: Kazandınız</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div style={{ background:"rgba(0,0,0,.3)", borderRadius:10, padding:"10px 14px" }}>
                  <div style={{ color:"rgba(255,255,255,.4)", fontSize:9, letterSpacing:1.5, textTransform:"uppercase", marginBottom:4 }}>Nominal İade</div>
                  <div style={{ color:"rgba(255,255,255,.7)", fontWeight:800, fontSize:16, fontFamily:"'Space Mono',monospace" }}>🪙 {finalData.nominal}</div>
                </div>
                <div style={{ background:"rgba(255,68,68,.08)", border:"1px solid rgba(255,68,68,.2)", borderRadius:10, padding:"10px 14px" }}>
                  <div style={{ color:"rgba(255,68,68,.7)", fontSize:9, letterSpacing:1.5, textTransform:"uppercase", marginBottom:4 }}>Enflasyon Erozyonu</div>
                  <div style={{ color:"#ff6b6b", fontWeight:800, fontSize:14, fontFamily:"'Space Mono',monospace" }}>-%{Math.round((1-finalData.multiplier)*100)}</div>
                </div>
              </div>
              {/* Erosion bar */}
              <div style={{ marginTop:14 }}>
                <div style={{ color:"rgba(255,255,255,.35)", fontSize:10, marginBottom:6 }}>Paranın reel değeri ({finalData.yearWon}. yıl sonunda):</div>
                <div style={{ height:8, background:"rgba(255,255,255,.06)", borderRadius:4, overflow:"hidden", position:"relative" }}>
                  <div style={{ height:"100%", borderRadius:4, background:"rgba(255,68,68,.4)", width:"100%", position:"absolute" }} />
                  <div style={{ height:"100%", borderRadius:4, background:"linear-gradient(90deg,#00d4aa88,#00d4aa)", width:`${finalData.multiplier*100}%`, position:"absolute", transition:"width 1.5s ease-out" }} />
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"rgba(255,255,255,.3)", marginTop:4 }}>
                  <span>🪙 0</span><span>🪙 {finalData.nominal}</span>
                </div>
              </div>
              <div style={{ marginTop:14, padding:"10px 14px", background:"rgba(255,100,50,.08)", border:"1px solid rgba(255,100,50,.25)", borderRadius:10, fontSize:12, color:"rgba(255,180,80,1)", lineHeight:1.7 }}>
                ⚠️ Adalet geç geldi, paranın değeri eridi!<br/>
                <strong style={{ color:"#fff" }}>Reel Kazancınız: 🪙 {finalData.reel}</strong> (nominal 🪙 {finalData.nominal}'in %{Math.round(finalData.multiplier*100)}'i)
              </div>
            </div>
          ) : (
            <div style={{ background:"rgba(255,68,68,.07)", border:"1px solid rgba(255,68,68,.3)", borderRadius:14, padding:"16px 18px", marginBottom:16 }}>
              <div style={{ color:"#ff4444", fontWeight:900, fontSize:16, marginBottom:8 }}>🏛️ Mahkeme Kararı: Kaybettiniz</div>
              <div style={{ color:"rgba(255,255,255,.55)", fontSize:13, lineHeight:1.7, marginBottom:10 }}>
                Kanıt yetersiz bulundu. 3 yıllık hukuki süreç sona erdi — avukat masrafı ve mahkeme harçları düşüldükten sonra ek 🪙 35 ödemeniz gerekiyor.
              </div>
              <div style={{ color:"rgba(255,100,80,.9)", fontSize:12 }}>⏳ 3 yıl harcadınız. Kazanamazdınız bile.</div>
            </div>
          )}

          {/* Smart Contract comparison box */}
          <div style={{ background:"rgba(0,212,170,.05)", border:"1px dashed rgba(0,212,170,.3)", borderRadius:14, padding:"14px 16px", marginBottom:16 }}>
            <div style={{ color:"#00d4aa", fontWeight:800, fontSize:13, marginBottom:8 }}>🔐 Smart Contract Kullansaydınız:</div>
            <div style={{ display:"flex", flexDirection:"column", gap:6, fontSize:12, color:"rgba(255,255,255,.6)", lineHeight:1.7 }}>
              <div>⚡ Para kasaya kilitliydi. Bot asla erişemezdi.</div>
              <div>🔄 Temerrüt anında <strong style={{ color:"#00d4aa" }}>otomatik iade</strong> — tam değeriyle, anında.</div>
              <div>⚖️ Dava? <strong style={{ color:"#00d4aa" }}>3 yıl bekleme? Yok.</strong> Enflasyon kaybı? <strong style={{ color:"#00d4aa" }}>Yok.</strong></div>
              <div>🪙 Net fark: Klasik yöntemde en iyi senaryoda <strong style={{ color:"#ff6b6b" }}>🪙 {finalData.reel ?? 0}</strong> geri alırsınız. Smart Contract'ta <strong style={{ color:"#00d4aa" }}>🪙 {finalData.original}</strong> tam iade.</div>
            </div>
          </div>

          <button onClick={onDone} style={{ background:"#00d4aa", color:"#000", border:"none", borderRadius:10, padding:"13px 28px", fontWeight:900, cursor:"pointer", width:"100%", fontSize:14 }}>
            Devam Et →
          </button>
        </div>
      )}
    </div>
  );
}

// ─── LEGAL RECEIPT ────────────────────────────────────────────────────────────

function LegalReceipt({ receipt }) {
  const { contractId, timestamp, botName, method, amount, legalStatus, actionTaken, params, realRecoveryRate, recoveryNote } = receipt;
  const isGood  = legalStatus === "İFA EDİLDİ";
  const isSmartRefund = legalStatus === "TEMERRÜDE DÜŞÜLDÜ (SC)";
  const accentColor = isGood ? "#00d4aa" : isSmartRefund ? "#00d4aa" : "#ff6b35";

  const fields = [
    ["CONTRACT ID",        contractId],
    ["TIMESTAMP",          timestamp],
    ["TARAF",              botName],
    ["YÖNTEM",             method === "smart" ? "Smart Contract" : "Klasik Anlaşma"],
    ["TUTAR",              `🪙 ${amount}`],
    method === "smart" && params && ["VADE",       `${params.timeout}s`],
    method === "smart" && params && ["CEZA ORANI", `%${params.penaltyRate}`],
    method === "smart" && params && ["ORACLE",     params.useOracle ? "AKTİF (+🪙 30)" : "KULLANILMADI"],
    ["LEGAL STATUS",       legalStatus],
    ["ACTION TAKEN",       actionTaken],
    realRecoveryRate !== undefined && ["REEL GERİ DÖNÜŞ ORANI", realRecoveryRate],
  ].filter(Boolean);

  return (
    <div style={{ background:"linear-gradient(145deg,#050c18,#080f1c)", border:`1px solid ${accentColor}44`, borderRadius:16, padding:"18px 20px", fontFamily:"'Space Mono',monospace", animation:"receiptIn .4s ease-out" }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px dashed rgba(255,255,255,.07)", paddingBottom:10, marginBottom:12 }}>
        <div>
          <div style={{ color:"rgba(255,255,255,.3)", fontSize:9, letterSpacing:2, textTransform:"uppercase" }}>Dijital Sözleşme Özeti</div>
          <div style={{ color:"#fff", fontWeight:700, fontSize:12, marginTop:2 }}>JUS DIGITALIS · v2.1</div>
        </div>
        <div style={{ display:"inline-block", padding:"3px 10px", borderRadius:20, background:`${accentColor}18`, border:`1px solid ${accentColor}44`, color:accentColor, fontSize:8, fontWeight:800, letterSpacing:1.5, textTransform:"uppercase" }}>
          {legalStatus}
        </div>
      </div>

      {/* Fields */}
      {fields.map(([k, v]) => (
        <div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6, fontSize:10 }}>
          <span style={{ color:"rgba(255,255,255,.3)", letterSpacing:.8, flexShrink:0 }}>{k}</span>
          <span style={{ color: k==="REEL GERİ DÖNÜŞ ORANI" ? (parseInt(v)<70?"#ff6b6b":"#00d4aa") : "#fff", fontWeight:700, textAlign:"right", maxWidth:"55%" }}>{v}</span>
        </div>
      ))}

      {/* Recovery note */}
      {recoveryNote && (
        <div style={{ marginTop:10, padding:"8px 12px", background:"rgba(255,100,50,.07)", borderRadius:8, fontSize:10, color:"rgba(255,180,80,.9)", lineHeight:1.7 }}>
          {recoveryNote}
        </div>
      )}

      {/* Seal */}
      <div style={{ borderTop:"1px dashed rgba(255,255,255,.07)", marginTop:12, paddingTop:10, textAlign:"center" }}>
        <div style={{ fontSize:9, color:"rgba(255,255,255,.18)", letterSpacing:1.5 }}>
          {isGood || isSmartRefund ? "✅ OTOMATİK YÜRÜTÜLDÜ" : "⚖️ HUKUKİ SÜREÇ TAMAMLANDI"}<br/>
          JUS DIGITALIS BLOCKCHAIN SIMÜLATÖRÜ · v2.1
        </div>
      </div>
    </div>
  );
}

// ─── FORCE MAJEURE BANNER ─────────────────────────────────────────────────────

function ForceMajeureBanner({ botName, reason }) {
  return (
    <div style={{ background:"rgba(155,89,182,.08)", border:"1px solid rgba(155,89,182,.35)", borderRadius:12, padding:"12px 16px", marginBottom:16, animation:"receiptIn .3s ease-out" }}>
      <div style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
        <span style={{ fontSize:22 }}>⚡</span>
        <div>
          <div style={{ color:"#9b59b6", fontWeight:800, fontSize:13, marginBottom:4 }}>Force Majeure / Beklenmedik Olay</div>
          <div style={{ color:"rgba(255,255,255,.6)", fontSize:12, lineHeight:1.65 }}>
            <strong style={{ color:"#fff" }}>{botName}</strong> teslim etmek istedi ama yapamadı:<br/>{reason}
          </div>
          <div style={{ marginTop:8, fontSize:11, color:"rgba(255,255,255,.4)", fontStyle:"italic" }}>
            Klasik hukukta bile bu durum tazminat anlamına gelir — ancak ispat yükü size aittir.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── BOT CARD ─────────────────────────────────────────────────────────────────

function BotCard({ bot, onSelect, disabled }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onClick={() => !disabled && onSelect(bot)}
      style={{
        cursor:disabled?"not-allowed":"pointer", opacity:disabled?.45:1,
        background:hovered?`linear-gradient(135deg,rgba(${bot.colorRgb},.14),rgba(0,0,0,.65))`:"rgba(255,255,255,.025)",
        border:`1px solid ${hovered?bot.color:"rgba(255,255,255,.07)"}`,
        borderRadius:18, padding:"22px",
        transition:"all .3s cubic-bezier(.4,0,.2,1)",
        transform:hovered?"translateY(-5px)":"none",
        boxShadow:hovered?`0 24px 48px rgba(0,0,0,.45),0 0 30px ${bot.color}18`:"none",
        position:"relative", overflow:"hidden",
      }}
    >
      <div style={{ position:"absolute", top:-24, right:-16, fontSize:90, opacity:.04, filter:"blur(3px)", pointerEvents:"none" }}>{bot.emoji}</div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
        <span style={{ fontSize:38 }}>{bot.emoji}</span>
        <span style={{ fontSize:9, fontWeight:800, letterSpacing:1.8, color:bot.riskColor, textTransform:"uppercase", background:`${bot.riskColor}18`, padding:"4px 10px", borderRadius:20, border:`1px solid ${bot.riskColor}33` }}>{bot.risk}</span>
      </div>
      <div style={{ color:"#fff", fontWeight:800, fontSize:17, marginBottom:2 }}>{bot.name}</div>
      <div style={{ color:bot.color, fontSize:10, letterSpacing:1.2, textTransform:"uppercase", marginBottom:10 }}>{bot.title}</div>
      <div style={{ color:"rgba(255,255,255,.5)", fontSize:12, lineHeight:1.7, marginBottom:14 }}>{bot.description}</div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
        <div>
          <div style={{ color:"rgba(255,255,255,.35)", fontSize:9, textTransform:"uppercase", letterSpacing:1 }}>Baz Maliyet</div>
          <div style={{ color:"#fff", fontWeight:900, fontSize:19, fontFamily:"'Space Mono',monospace" }}>🪙 {bot.basePrice}</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ color:"rgba(255,255,255,.35)", fontSize:9, textTransform:"uppercase", letterSpacing:1 }}>Kazanç Potansiyeli</div>
          <div style={{ color:bot.color, fontWeight:900, fontSize:19, fontFamily:"'Space Mono',monospace" }}>+🪙 {bot.reward}</div>
        </div>
      </div>
      {/* Success rate indicator */}
      <div style={{ marginBottom:12 }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
          <span style={{ color:"rgba(255,255,255,.3)", fontSize:9, textTransform:"uppercase", letterSpacing:1 }}>İfa Güvenilirliği</span>
          <span style={{ color:bot.color, fontSize:9, fontWeight:700 }}>%{Math.round(bot.baseSuccessRate*100)}</span>
        </div>
        <div style={{ height:3, background:"rgba(255,255,255,.06)", borderRadius:2, overflow:"hidden" }}>
          <div style={{ height:"100%", background:`linear-gradient(90deg,${bot.color}66,${bot.color})`, width:`${bot.baseSuccessRate*100}%`, borderRadius:2 }} />
        </div>
      </div>
      <div style={{ padding:"7px 11px", background:"rgba(255,255,255,.025)", borderRadius:8, fontSize:11, color:"rgba(255,255,255,.35)", fontStyle:"italic" }}>"{bot.catchphrase}"</div>
    </div>
  );
}

// ─── INFO PANEL ───────────────────────────────────────────────────────────────

function InfoPanel() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} style={{ background:"rgba(0,212,170,.08)", border:"1px solid rgba(0,212,170,.25)", color:"#00d4aa", borderRadius:8, padding:"8px 16px", fontSize:12, fontWeight:700, cursor:"pointer" }}>
        ℹ️ Smart Contract Nedir?
      </button>
      {open && (
        <div style={{ position:"fixed", inset:0, zIndex:300, background:"rgba(0,0,0,.92)", backdropFilter:"blur(12px)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:"linear-gradient(145deg,#0d1924,#111a27)", border:"1px solid rgba(0,212,170,.25)", borderRadius:22, padding:36, maxWidth:580, width:"100%" }}>
            <div style={{ color:"#fff", fontWeight:900, fontSize:22, marginBottom:6 }}>🔐 Smart Contract</div>
            <div style={{ color:"rgba(0,212,170,.7)", fontSize:12, letterSpacing:2, textTransform:"uppercase", marginBottom:24 }}>Trustless Trust · v2.1</div>
            {[
              { icon:"🔒", t:"Para Kilitlenir",      d:"Ödeme kasaya kilitlenir. Bot parasına erişemez — ne kadar dürüst olursa olsun." },
              { icon:"🔮", t:"Oracle Katmanı",        d:"Dış dünya doğrulaması. Teslim yoksa sözleşme otomatik iade başlatır." },
              { icon:"⏳", t:"Enflasyon Koruması",   d:"Klasik hukukta 3 yıl sonra kazansanız bile paranın %60'ı erimiş olabilir. Smart Contract anında iade eder." },
              { icon:"⚡", t:"Force Majeure Farkı",  d:"Dürüst bot bile iflas edebilir. Smart Contract'ta paranız kasada olduğundan hiç risk almaksızın iade alırsınız." },
              { icon:"🌐", t:"Trustless Trust",       d:"İnsanlara değil koda güvenin. Kod çalışır, mahkeme bekletmez." },
            ].map((x,i) => (
              <div key={i} style={{ display:"flex", gap:14, marginBottom:16 }}>
                <div style={{ fontSize:22, flexShrink:0, marginTop:1 }}>{x.icon}</div>
                <div>
                  <div style={{ color:"#00d4aa", fontWeight:700, marginBottom:3 }}>{x.t}</div>
                  <div style={{ color:"rgba(255,255,255,.55)", fontSize:12, lineHeight:1.65 }}>{x.d}</div>
                </div>
              </div>
            ))}
            <button onClick={() => setOpen(false)} style={{ marginTop:8, background:"#00d4aa", color:"#000", border:"none", borderRadius:10, padding:"13px 28px", fontWeight:900, cursor:"pointer", width:"100%", fontSize:14 }}>Anladım!</button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── CONTRACT MODAL v2.1 ─────────────────────────────────────────────────────

function ContractModal({ bot, coins, onClose, onResult, addLog }) {
  const [phase, setPhase]               = useState("choose");
  const [method, setMethod]             = useState(null);
  const [params, setParams]             = useState({ timeout:30, penaltyRate:50, useOracle:false });
  const [effectivePrice, setEffectivePrice] = useState(bot.basePrice);
  const [botEval, setBotEval]           = useState(null);
  const [vaultPhase, setVaultPhase]     = useState("idle");
  const [result, setResult]             = useState(null);
  const [receipt, setReceipt]           = useState(null);
  const [failureReason, setFailureReason] = useState(null);

  // Zaman Tüneli state
  const [tunnelYear, setTunnelYear]     = useState(1);
  const [tunnelEventIdx, setTunnelEventIdx] = useState(0);
  const [tunnelWon, setTunnelWon]       = useState(null);
  const [tunnelFinal, setTunnelFinal]   = useState(null);
  const timerRef                         = useRef(null);
  const contractId                       = useRef(genContractId());

  const totalCost   = effectivePrice + (params.useOracle ? ORACLE_FEE : 0);
  const notEnough   = coins < totalCost;

  // Bot re-evaluation when architect params change
  useEffect(() => {
    if (method === "smart") {
      const ev = botEvaluateContract(bot, params);
      setBotEval(ev);
      setEffectivePrice(Math.round(bot.basePrice * ev.priceMultiplier));
      if (ev.reason) addLog({ msg:`🤖 ${bot.name}: ${ev.reason}`, color:ev.refused?"#ff4444":"#f39c12" });
    } else {
      setEffectivePrice(bot.basePrice);
      setBotEval(null);
    }
  }, [params, method]);

  // ── Execute Classic ──────────────────────────────────────

  function executeClassic() {
    setMethod("classic"); setPhase("waiting");
    addLog({ msg:`[KLASİK] ${bot.name} ile anlaşma. 🪙 ${bot.basePrice} ödendi.`, color:"#f39c12" });

    setTimeout(() => {
      const success = Math.random() < bot.baseSuccessRate;
      if (success) {
        const delta = bot.reward - bot.basePrice;
        onResult(delta);
        setResult({ success:true, delta });
        setReceipt({ contractId:contractId.current, timestamp:nowStr(), botName:bot.name, method:"classic", amount:bot.basePrice, legalStatus:"İFA EDİLDİ", actionTaken:`🪙 ${delta} net ödeme`, params:null, realRecoveryRate:"100%" });
        addLog({ msg:`✅ ${bot.name} teslim etti! +🪙 ${delta}`, color:"#00d4aa" });
        setPhase("result");
      } else {
        // Dürüst bot → force majeure, diğerleri → fraud
        const isFM = bot.failureType === "force_majeure";
        const reason = isFM ? pickRandom(HONEST_FAILURE_REASONS) : null;
        if (reason) setFailureReason(reason);
        onResult(-bot.basePrice);
        setReceipt({ contractId:contractId.current, timestamp:nowStr(), botName:bot.name, method:"classic", amount:bot.basePrice, legalStatus:"TEMERRÜT", actionTaken:isFM?"Force majeure — hukuki süreç başlatıldı":"Para alındı, teslim yapılmadı", params:null });
        addLog({ msg:isFM ? `⚡ ${bot.name} teslim edemedi! ${reason}` : `❌ ${bot.name} parayı alıp kaçtı!`, color:"#ff4444" });
        setPhase("lawsuit");
      }
    }, bot.delay);
  }

  // ── Execute Smart ────────────────────────────────────────

  function executeSmart() {
    if (botEval?.refused) return;
    const finalPrice = totalCost;
    setPhase("waiting"); setVaultPhase("waiting");
    addLog({ msg:`[SMART CONTRACT #${contractId.current}] 🔒 🪙 ${finalPrice} kasaya kilitlendi.`, color:"#9b59b6" });

    const successRate = computeSuccessRate(bot, params);
    const delay = Math.min(params.timeout * 80, 4000);

    setTimeout(() => {
      const success = Math.random() < successRate;
      if (success) {
        setVaultPhase("released");
        const delta = bot.reward - finalPrice;
        onResult(delta);
        setResult({ success:true, delta });
        setReceipt({ contractId:contractId.current, timestamp:nowStr(), botName:bot.name, method:"smart", amount:finalPrice, legalStatus:"İFA EDİLDİ", actionTaken:`🪙 ${delta} net kazanç`, params, realRecoveryRate:"100% — tam ve anında" });
        addLog({ msg:`✅ Teslimat doğrulandı. Sözleşme otomatik yürütüldü. +🪙 ${delta}`, color:"#00d4aa" });
        setPhase("result");
      } else {
        const penaltyAmount = Math.round(finalPrice * (params.penaltyRate / 100));
        setVaultPhase("refunded");
        // Smart contract: para kasadan hiç çıkmadı — tam iade, enflasyon yok
        onResult(0);  // net 0: tam iade (bakiye değişmez)
        setResult({ success:false, delta:0, penaltyAmount, refunded:finalPrice });
        setReceipt({
          contractId:contractId.current, timestamp:nowStr(), botName:bot.name, method:"smart",
          amount:finalPrice, legalStatus:"TEMERRÜDE DÜŞÜLDÜ (SC)",
          actionTaken:`🔄 🪙 ${finalPrice} ANINDA TAM İADE | Enflasyon kaybı: YOK`,
          params, realRecoveryRate:"100% — kasadan hiç çıkmadı",
          recoveryNote:`📊 Klasik hukukta bu parayı 3 yılda ortalama %40–55 ile geri alırdınız. Smart Contract: anında, tam.`,
        });
        addLog({ msg:`🔄 ${bot.name} teslim etmedi. Para kasadaydı — 🪙 ${finalPrice} ANINDA iade edildi.`, color:"#00d4aa" });
        addLog({ msg:`💡 Klasik yöntemde aynı para için 3 yıl mahkeme sürecine girerdiniz. Enflasyon farkı: ciddi.`, color:"rgba(0,212,170,.6)" });
        setPhase("result");
      }
    }, delay);
  }

  // ── Zaman Tüneli ─────────────────────────────────────────

  function startTimeTunnel() {
    setPhase("tunnel");
    const won = Math.random() < 0.40;
    setTunnelWon(won);
    setTunnelYear(1); setTunnelEventIdx(0);
    addLog({ msg:`⚖️ Zaman Tüneli: Dava süreci başlıyor...`, color:"#f39c12" });

    let year = 1, evIdx = 0;
    const INTERVAL = 1400; // ms per event

    timerRef.current = setInterval(() => {
      const yearData = LAWSUIT_YEARS[year - 1];
      evIdx += 1;

      if (evIdx < yearData.events.length) {
        setTunnelEventIdx(evIdx);
        addLog({ msg:`📅 ${yearData.label}: ${yearData.events[evIdx]}`, color:"rgba(243,156,18,.8)" });
      } else {
        // Move to next year
        year += 1;
        if (year <= 3) {
          setTunnelYear(year);
          setTunnelEventIdx(0);
          evIdx = 0;
          addLog({ msg:`📅 ${LAWSUIT_YEARS[year-1].label}: ${LAWSUIT_YEARS[year-1].events[0]}`, color:"rgba(243,156,18,.8)" });
        } else {
          // Done — finalize
          clearInterval(timerRef.current);
          setTunnelYear(4); // triggers "done" state

          const nominal = Math.floor(bot.basePrice * 0.65); // mahkeme + avukat sonrası brüt iade
          const inflation = computeInflatedRefund(nominal, 3); // 3. yılda kazan

          if (won) {
            onResult(inflation.reel);
            setTunnelFinal({ ...inflation, nominal, original:bot.basePrice });
            addLog({ msg:`⚖️ KARAR: Dava KAZANILDI. Nominal iade: 🪙 ${nominal}. Ama 3 yılda eridi: 🪙 ${inflation.reel} reel.`, color:"#f39c12" });
            addLog({ msg:`📉 Adalet geç geldi, paranın değeri eridi! Reel geri dönüş: %${Math.round(inflation.multiplier*100)}`, color:"#ff6b6b" });
          } else {
            onResult(-35);
            setTunnelFinal({ reel:0, nominal:0, multiplier:0, yearWon:3, original:bot.basePrice });
            addLog({ msg:`⚖️ KARAR: Dava KAYBEDİLDİ. 3 yıl harcandı + 🪙 35 mahkeme masrafı.`, color:"#ff4444" });
          }
        }
      }
    }, INTERVAL);
  }

  useEffect(() => () => clearInterval(timerRef.current), []);

  // ── Styles ───────────────────────────────────────────────

  const overlay = { position:"fixed", inset:0, zIndex:100, background:"rgba(0,0,0,.88)", backdropFilter:"blur(10px)", display:"flex", alignItems:"center", justifyContent:"center", padding:16, overflowY:"auto" };
  const card    = { background:"linear-gradient(145deg,#0c1522,#0f1b2c)", border:`1px solid ${bot.color}33`, borderRadius:22, padding:"28px 30px", maxWidth:640, width:"100%", boxShadow:`0 0 80px ${bot.color}14,0 50px 100px rgba(0,0,0,.7)`, position:"relative", maxHeight:"92vh", overflowY:"auto" };

  const BotHeader = () => (
    <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:22 }}>
      <span style={{ fontSize:42 }}>{bot.emoji}</span>
      <div style={{ flex:1 }}>
        <div style={{ color:"#fff", fontWeight:900, fontSize:20 }}>{bot.name}</div>
        <div style={{ color:bot.color, fontSize:11, letterSpacing:1.2, textTransform:"uppercase" }}>{bot.title}</div>
      </div>
      <button onClick={onClose} style={{ background:"none", border:"none", color:"rgba(255,255,255,.3)", fontSize:22, cursor:"pointer" }}>✕</button>
    </div>
  );

  return (
    <div style={overlay}>
      <div style={card}>
        <BotHeader />

        {/* ── choose ── */}
        {phase === "choose" && (
          <>
            <div style={{ color:"rgba(255,255,255,.55)", fontSize:13, marginBottom:24, lineHeight:1.75, background:"rgba(255,255,255,.02)", borderRadius:10, padding:"12px 14px", border:"1px solid rgba(255,255,255,.06)" }}>
              <strong style={{ color:"#fff" }}>{bot.name}</strong> ile <strong style={{ color:bot.color, fontFamily:"'Space Mono',monospace" }}>🪙 {bot.basePrice}</strong> karşılığında anlaşmak istiyorsunuz. Başarı halinde <strong style={{ color:bot.color }}>🪙 {bot.reward}</strong> kazanırsınız. İfa güvenilirliği: <strong style={{ color:bot.color }}>%{Math.round(bot.baseSuccessRate*100)}</strong>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
              {/* Classic */}
              <div onClick={() => { setMethod("classic"); executeClassic(); }}
                style={{ background:"rgba(243,156,18,.06)", border:"1px solid rgba(243,156,18,.25)", borderRadius:16, padding:"20px 18px", cursor:"pointer", transition:"all .2s" }}
                onMouseEnter={e=>e.currentTarget.style.borderColor="#f39c12"}
                onMouseLeave={e=>e.currentTarget.style.borderColor="rgba(243,156,18,.25)"}
              >
                <div style={{ fontSize:32, marginBottom:10 }}>📄</div>
                <div style={{ color:"#f39c12", fontWeight:800, fontSize:13, marginBottom:4 }}>Seçenek A</div>
                <div style={{ color:"#fff", fontWeight:700, marginBottom:8 }}>Klasik Yöntem</div>
                <div style={{ color:"rgba(255,255,255,.45)", fontSize:11, lineHeight:1.65 }}>Sözlü anlaşma. Parayı peşin ödersin. Başarısızlıkta dava — yıllarca sürer.</div>
                <div style={{ marginTop:12, fontSize:10, color:"#ff4444", fontWeight:700 }}>⚠️ Dava = Zaman + Enflasyon Kaybı</div>
              </div>
              {/* Smart */}
              <div onClick={() => { setMethod("smart"); setPhase("architect"); }}
                style={{ background:"rgba(0,212,170,.06)", border:"2px solid rgba(0,212,170,.35)", borderRadius:16, padding:"20px 18px", cursor:"pointer", transition:"all .2s", position:"relative" }}
                onMouseEnter={e=>e.currentTarget.style.borderColor="#00d4aa"}
                onMouseLeave={e=>e.currentTarget.style.borderColor="rgba(0,212,170,.35)"}
              >
                <div style={{ position:"absolute", top:-10, right:14, background:"#00d4aa", color:"#000", fontSize:8, fontWeight:900, padding:"2px 9px", borderRadius:20, letterSpacing:1.5 }}>ÖNERİLEN</div>
                <div style={{ fontSize:32, marginBottom:10 }}>🔐</div>
                <div style={{ color:"#00d4aa", fontWeight:800, fontSize:13, marginBottom:4 }}>Seçenek B</div>
                <div style={{ color:"#fff", fontWeight:700, marginBottom:8 }}>Smart Contract</div>
                <div style={{ color:"rgba(255,255,255,.45)", fontSize:11, lineHeight:1.65 }}>Para kasaya kilitlenir. Temerrüt → anında tam iade. Enflasyon kaybı yok.</div>
                <div style={{ marginTop:12, fontSize:10, color:"#00d4aa", fontWeight:700 }}>✅ Anında · Tam · Güven gerektirmez</div>
              </div>
            </div>
          </>
        )}

        {/* ── architect ── */}
        {phase === "architect" && (
          <>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
              <div style={{ width:3, height:22, background:"#00d4aa", borderRadius:2 }} />
              <div style={{ color:"#fff", fontWeight:800, fontSize:16 }}>Sözleşme Mimarı Paneli</div>
              <div style={{ marginLeft:"auto", fontSize:10, color:"rgba(255,255,255,.3)", fontFamily:"'Space Mono',monospace" }}>#{contractId.current}</div>
            </div>

            {botEval?.refused && (
              <div style={{ background:"rgba(255,68,68,.1)", border:"1px solid rgba(255,68,68,.4)", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:12, color:"#ff4444", display:"flex", gap:8, alignItems:"center" }}>
                <span style={{ fontSize:20 }}>🤖</span>
                <div><strong>{bot.name}</strong> bu şartları imzalamayı reddediyor. Parametreleri yumuşat.</div>
              </div>
            )}
            {botEval?.priceMultiplier > 1 && !botEval?.refused && (
              <div style={{ background:"rgba(243,156,18,.08)", border:"1px solid rgba(243,156,18,.35)", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:12, color:"#f39c12", display:"flex", gap:8, alignItems:"center" }}>
                <span style={{ fontSize:20 }}>🦊</span>
                <div>{bot.name} sözleşmeyi riskli buldu. Fiyat <strong>🪙 {bot.basePrice} → 🪙 {effectivePrice}</strong>.</div>
              </div>
            )}

            <div style={{ background:"rgba(0,0,0,.3)", borderRadius:14, padding:"18px 18px 6px", border:"1px solid rgba(255,255,255,.06)", marginBottom:18 }}>
              <SliderParam label="Vade (Timeout)" sublabel="Botun teslim süresi" value={params.timeout} min={5} max={60} onChange={v=>setParams(p=>({...p,timeout:v}))} unit="s" color="#00d4aa" />
              <SliderParam label="Gecikme Cezası" sublabel="Temerrüt ceza kaydı" value={params.penaltyRate} min={0} max={100} onChange={v=>setParams(p=>({...p,penaltyRate:v}))} unit="%" color="#ff6b35" />
            </div>

            {/* Oracle */}
            <div style={{ background:"rgba(155,89,182,.07)", border:"1px solid rgba(155,89,182,.25)", borderRadius:14, padding:"14px 18px", marginBottom:18, display:"flex", alignItems:"center", gap:14 }}>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                  <span style={{ fontSize:18 }}>🔮</span>
                  <span style={{ color:"#fff", fontWeight:700, fontSize:13 }}>Oracle Doğrulaması</span>
                  <span style={{ fontSize:10, color:"#9b59b6", background:"rgba(155,89,182,.2)", padding:"2px 8px", borderRadius:12, fontWeight:700 }}>+🪙 {ORACLE_FEE}</span>
                </div>
                <div style={{ color:"rgba(255,255,255,.45)", fontSize:11, lineHeight:1.55 }}>Aktif ise teslim doğrulaması dış dünyadan gelir. Yalan söylemek imkansızlaşır.</div>
              </div>
              <div onClick={() => setParams(p=>({...p,useOracle:!p.useOracle}))} style={{ width:52, height:28, borderRadius:14, cursor:"pointer", flexShrink:0, background:params.useOracle?"#9b59b6":"rgba(255,255,255,.1)", border:`2px solid ${params.useOracle?"#9b59b6":"rgba(255,255,255,.15)"}`, position:"relative", transition:"all .25s" }}>
                <div style={{ width:20, height:20, borderRadius:"50%", background:"#fff", position:"absolute", top:2, left:params.useOracle?26:2, transition:"left .25s", boxShadow:"0 2px 4px rgba(0,0,0,.4)" }} />
              </div>
            </div>

            {/* Cost */}
            <div style={{ background:"rgba(0,212,170,.05)", border:"1px solid rgba(0,212,170,.2)", borderRadius:12, padding:"12px 16px", marginBottom:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"rgba(255,255,255,.5)", marginBottom:6 }}>
                <span>Bot Bedeli</span>
                <span style={{ fontFamily:"'Space Mono',monospace" }}>🪙 {effectivePrice}</span>
              </div>
              {params.useOracle && (
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"rgba(155,89,182,.8)", marginBottom:6 }}>
                  <span>Oracle Ücreti</span><span style={{ fontFamily:"'Space Mono',monospace" }}>🪙 {ORACLE_FEE}</span>
                </div>
              )}
              <div style={{ borderTop:"1px solid rgba(255,255,255,.07)", marginTop:8, paddingTop:8, display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"#fff", fontWeight:800 }}>Toplam</span>
                <span style={{ color:totalCost>coins?"#ff4444":"#00d4aa", fontWeight:900, fontFamily:"'Space Mono',monospace", fontSize:16 }}>🪙 {totalCost}</span>
              </div>
              {notEnough && <div style={{ color:"#ff4444", fontSize:11, marginTop:8 }}>❌ Yetersiz bakiye</div>}
            </div>

            <div style={{ display:"flex", gap:10 }}>
              <button onClick={() => setPhase("choose")} style={{ flex:1, background:"transparent", border:"1px solid rgba(255,255,255,.15)", color:"rgba(255,255,255,.5)", borderRadius:10, padding:12, fontWeight:700, cursor:"pointer", fontSize:13 }}>← Geri</button>
              <button onClick={executeSmart} disabled={botEval?.refused||notEnough}
                style={{ flex:2, background:botEval?.refused||notEnough?"rgba(255,255,255,.05)":"#00d4aa", border:"none", color:botEval?.refused||notEnough?"rgba(255,255,255,.2)":"#000", borderRadius:10, padding:12, fontWeight:900, cursor:botEval?.refused||notEnough?"not-allowed":"pointer", fontSize:14, letterSpacing:.5, transition:"all .2s" }}>
                {botEval?.refused ? "Bot Reddetti" : "🔐 Sözleşmeyi Kilitle"}
              </button>
            </div>
          </>
        )}

        {/* ── waiting ── */}
        {phase === "waiting" && (
          <div style={{ textAlign:"center", padding:"10px 0" }}>
            {method === "smart" ? (
              <>
                <DigitalVault amount={totalCost} phase={vaultPhase} color={bot.color} />
                <div style={{ color:"#fff", fontWeight:800, fontSize:15, marginTop:4 }}>Sözleşme yürütülüyor...</div>
                <div style={{ color:"rgba(255,255,255,.4)", fontSize:12, marginTop:4 }}>Paranız kasada kilitli. Vade: {params.timeout}s</div>
              </>
            ) : (
              <>
                <div style={{ fontSize:52, marginBottom:16, animation:"float 2s ease-in-out infinite" }}>⏳</div>
                <div style={{ color:"#fff", fontWeight:800, fontSize:15 }}>Klasik anlaşma işleniyor...</div>
                <div style={{ color:"rgba(255,255,255,.4)", fontSize:12, marginTop:6 }}>Botun yanıt vermesi bekleniyor.</div>
                <div style={{ marginTop:20, display:"flex", gap:8, justifyContent:"center" }}>
                  {[0,1,2].map(i=>(<div key={i} style={{ width:8, height:8, borderRadius:"50%", background:"#f39c12", animation:`pulse 1.2s ${i*.4}s infinite` }} />))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── lawsuit ── */}
        {phase === "lawsuit" && (
          <div style={{ padding:"8px 0" }}>
            <div style={{ fontSize:48, textAlign:"center", marginBottom:12 }}>💸</div>
            <div style={{ color:"#ff4444", fontWeight:900, fontSize:20, textAlign:"center", marginBottom:10 }}>
              {bot.failureType === "force_majeure" ? "İfa Edilemedi!" : "Bot Parayı Aldı ve Kaçtı!"}
            </div>

            {failureReason && bot.failureType === "force_majeure" && (
              <ForceMajeureBanner botName={bot.name} reason={failureReason} />
            )}

            <div style={{ color:"rgba(255,255,255,.5)", fontSize:13, lineHeight:1.75, marginBottom:18, background:"rgba(255,255,255,.02)", borderRadius:10, padding:"12px 14px", border:"1px solid rgba(255,255,255,.06)" }}>
              Klasik yöntemde parayı peşin ödediniz. Hukuki yola başvurabilirsiniz — ama bu <strong style={{ color:"#f39c12" }}>3 yıllık</strong> bir süreç ve kazansanız bile paranızın değeri erir.
            </div>

            <button onClick={startTimeTunnel} style={{ background:"#f39c12", color:"#000", border:"none", borderRadius:10, padding:"13px 28px", fontWeight:900, cursor:"pointer", fontSize:14, width:"100%" }}>
              ⚖️ Dava Aç — Zaman Tüneline Gir
            </button>
          </div>
        )}

        {/* ── tunnel ── */}
        {phase === "tunnel" && (
          <TimeTunnel
            currentYear={tunnelYear}
            currentEventIdx={tunnelEventIdx}
            won={tunnelWon}
            finalData={tunnelYear > 3 ? tunnelFinal : null}
            onDone={onClose}
          />
        )}

        {/* ── result ── */}
        {phase === "result" && result && (
          <div style={{ padding:"4px 0" }}>
            <div style={{ textAlign:"center", marginBottom:20 }}>
              {result.success ? (
                <>
                  <div style={{ fontSize:54, marginBottom:10, animation:"float 2s ease-in-out infinite" }}>🎉</div>
                  <div style={{ color:"#00d4aa", fontWeight:900, fontSize:24, fontFamily:"'Space Mono',monospace", animation:"countUp .4s ease-out" }}>+🪙 {result.delta}</div>
                  <div style={{ color:"rgba(255,255,255,.45)", fontSize:12, marginTop:6, lineHeight:1.6 }}>
                    {method==="smart" ? "Teslimat doğrulandı → Sözleşme otomatik yürütüldü → Ödeme bota aktarıldı." : "Bot sözünü tuttu."}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize:54, marginBottom:10, animation:"float 2s ease-in-out infinite" }}>🔄</div>
                  <div style={{ color:"#00d4aa", fontWeight:900, fontSize:20, marginBottom:6 }}>Otomatik Koruma — Anında İade!</div>
                  <div style={{ color:"rgba(255,255,255,.5)", fontSize:12, lineHeight:1.75, marginBottom:14 }}>
                    {bot.name} teslim etmedi. Ama paranız kasadaydı — hiç çıkmadı.<br/>
                    <strong style={{ color:"#00d4aa" }}>🪙 {result.refunded}</strong> ANINDA ve TAM DEĞERIYLE iade edildi.
                  </div>
                  {/* Side-by-side comparison */}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, textAlign:"left", marginBottom:16 }}>
                    <div style={{ background:"rgba(255,68,68,.07)", border:"1px solid rgba(255,68,68,.25)", borderRadius:12, padding:"12px 14px" }}>
                      <div style={{ color:"#ff6b6b", fontWeight:800, fontSize:11, marginBottom:8 }}>📄 Klasik Yöntemde</div>
                      <div style={{ color:"rgba(255,255,255,.6)", fontSize:11, lineHeight:1.8 }}>
                        ⏳ 3 yıl dava<br/>
                        📉 %40–60 enflasyon erozyonu<br/>
                        ⚖️ Belirsiz karar<br/>
                        💸 Kazansan bile: ~🪙 {Math.floor(result.refunded * 0.45)}
                      </div>
                    </div>
                    <div style={{ background:"rgba(0,212,170,.07)", border:"1px solid rgba(0,212,170,.3)", borderRadius:12, padding:"12px 14px" }}>
                      <div style={{ color:"#00d4aa", fontWeight:800, fontSize:11, marginBottom:8 }}>🔐 Smart Contract</div>
                      <div style={{ color:"rgba(255,255,255,.6)", fontSize:11, lineHeight:1.8 }}>
                        ⚡ Anında iade<br/>
                        💯 Tam değer korundu<br/>
                        🚫 Dava yok<br/>
                        🪙 <strong style={{ color:"#00d4aa" }}>{result.refunded}</strong> — hemen şimdi
                      </div>
                    </div>
                  </div>
                  <div style={{ background:"rgba(0,212,170,.08)", border:"1px solid rgba(0,212,170,.25)", borderRadius:12, padding:"12px 14px", fontSize:12, color:"rgba(255,255,255,.7)", lineHeight:1.8 }}>
                    💡 <strong style={{ color:"#00d4aa" }}>Trustless Trust:</strong> Koda güvendiniz. Kod çalıştı. Bota güvenmek zorunda değildiniz.
                  </div>
                </>
              )}
            </div>

            {receipt && (
              <>
                <div style={{ color:"rgba(255,255,255,.25)", fontSize:9, letterSpacing:2.5, textTransform:"uppercase", marginBottom:10 }}>Dijital Sözleşme Kanıtı</div>
                <LegalReceipt receipt={receipt} />
              </>
            )}
            <button onClick={onClose} style={{ marginTop:18, background:"#00d4aa", color:"#000", border:"none", borderRadius:10, padding:"13px 28px", fontWeight:900, cursor:"pointer", width:"100%", fontSize:14 }}>Devam Et →</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [coins, setCoins]       = useState(INITIAL_COINS);
  const [coinChange, setCoinChange] = useState(0);
  const [logs, setLogs]         = useState([
    { msg:"Jus Digitalis v2.1 — Enflasyon & Zaman Tüneli aktif.", color:"#00d4aa", time:"00:00" },
    { msg:`Başlangıç bakiyesi: 🪙 ${INITIAL_COINS} JusCoin`, color:"#fff", time:"00:00" },
    { msg:"Klasik davada zamanın maliyetini bizzat yaşayın.", color:"rgba(255,255,255,.4)", time:"00:00" },
  ]);
  const [activeBot, setActiveBot] = useState(null);
  const [stats, setStats]       = useState({ deals:0, won:0, lost:0 });
  const startTime                = useRef(Date.now());

  function getTime() { return getSessionTime(startTime.current); }
  function addLog(e) { setLogs(prev=>[...prev.slice(-80), { ...e, time:getTime() }]); }

  function handleResult(delta) {
    setCoins(prev=>Math.max(0, prev+delta));
    setCoinChange(delta);
    setTimeout(()=>setCoinChange(0), 950);
    setStats(prev=>({ ...prev, deals:prev.deals+1, won:delta>0?prev.won+1:prev.won, lost:delta<=0?prev.lost+1:prev.lost }));
  }

  function resetGame() {
    setCoins(INITIAL_COINS); setCoinChange(INITIAL_COINS);
    setStats({ deals:0, won:0, lost:0 });
    addLog({ msg:"🔄 Simülasyon sıfırlandı. 🪙 1000 JusCoin yüklendi.", color:"#00d4aa" });
    setTimeout(()=>setCoinChange(0), 1000);
  }

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <CityGrid />
      <div style={{ position:"fixed", top:0, left:0, right:0, height:2, background:"linear-gradient(transparent,rgba(0,212,170,.08),transparent)", zIndex:1, animation:"scanline 10s linear infinite", pointerEvents:"none" }} />

      <div style={{ position:"relative", zIndex:10, minHeight:"100vh", padding:"24px 20px", maxWidth:980, margin:"0 auto" }}>

        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:36, flexWrap:"wrap", gap:16 }}>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:"#00d4aa", boxShadow:"0 0 12px #00d4aa", animation:"pulse 2s infinite" }} />
              <span style={{ color:"rgba(0,212,170,.65)", fontSize:10, letterSpacing:3.5, textTransform:"uppercase", fontFamily:"'Space Mono',monospace" }}>Jus Digitalis</span>
              <span style={{ color:"rgba(255,255,255,.2)", fontSize:10, fontFamily:"'Space Mono',monospace" }}>v2.1</span>
            </div>
            <h1 style={{ color:"#fff", fontSize:30, fontWeight:900, lineHeight:1.1 }}>Algoritmik <span style={{ color:"#00d4aa" }}>Şehir</span></h1>
            <p style={{ color:"rgba(255,255,255,.35)", fontSize:12, marginTop:6 }}>Enflasyon & Zaman Tüneli · Trustless Trust</p>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:10, alignItems:"flex-end" }}>
            <CoinDisplay coins={coins} change={coinChange} />
            <div style={{ display:"flex", gap:8 }}>
              <InfoPanel />
              <button onClick={resetGame} style={{ background:"rgba(255,255,255,.04)", border:"1px solid rgba(255,255,255,.12)", color:"rgba(255,255,255,.4)", borderRadius:8, padding:"8px 14px", fontSize:11, fontWeight:700, cursor:"pointer" }}>↺ Sıfırla</button>
            </div>
          </div>
        </div>

        {/* Stats */}
        {stats.deals > 0 && (
          <div style={{ display:"flex", gap:10, marginBottom:28, flexWrap:"wrap" }}>
            {[
              { label:"Toplam", value:stats.deals, color:"#fff" },
              { label:"Kazanılan", value:stats.won, color:"#00d4aa" },
              { label:"Kaybedilen", value:stats.lost, color:"#ff4444" },
              { label:"Kâr/Zarar", value:`${coins-INITIAL_COINS>=0?"+":""}${coins-INITIAL_COINS}`, color:coins>=INITIAL_COINS?"#00d4aa":"#ff4444" },
            ].map((s,i)=>(
              <div key={i} style={{ background:"rgba(255,255,255,.025)", border:"1px solid rgba(255,255,255,.06)", borderRadius:12, padding:"10px 18px" }}>
                <div style={{ color:"rgba(255,255,255,.35)", fontSize:9, letterSpacing:1.5, textTransform:"uppercase", marginBottom:3 }}>{s.label}</div>
                <div style={{ color:s.color, fontWeight:900, fontSize:20, fontFamily:"'Space Mono',monospace" }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Bots */}
        <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:18 }}>
          <div style={{ flex:1, height:1, background:"rgba(255,255,255,.05)" }} />
          <span style={{ color:"rgba(255,255,255,.25)", fontSize:10, letterSpacing:2.5, textTransform:"uppercase" }}>Şehirdeki Botlar</span>
          <div style={{ flex:1, height:1, background:"rgba(255,255,255,.05)" }} />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:16, marginBottom:30 }}>
          {BOTS.map(bot=>(
            <BotCard key={bot.id} bot={bot} onSelect={setActiveBot} disabled={coins < bot.basePrice} />
          ))}
        </div>

        {/* Enflasyon bilgi kutusu */}
        <div style={{ background:"rgba(255,107,53,.04)", border:"1px solid rgba(255,107,53,.18)", borderRadius:18, padding:"18px 24px", marginBottom:24 }}>
          <div style={{ color:"rgba(255,107,53,.8)", fontSize:10, letterSpacing:2.5, textTransform:"uppercase", marginBottom:12 }}>⏳ Paranın Zaman Maliyeti</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12 }}>
            {[
              { n:"1. YIL", rate:"~%75", desc:"Kısmi reel değer" },
              { n:"2. YIL", rate:"~%55", desc:"Yarısından fazlası eridi" },
              { n:"3. YIL", rate:"~%40", desc:"Kazansan bile..." },
              { n:"Smart Contract", rate:"%100", desc:"Anında, tam, enflasyondan muaf", green:true },
            ].map(s=>(
              <div key={s.n} style={{ display:"flex", gap:10 }}>
                <div style={{ color:s.green?"#00d4aa":"#ff6b35", fontFamily:"'Space Mono',monospace", fontSize:10, fontWeight:700, flexShrink:0, paddingTop:2 }}>{s.rate}</div>
                <div>
                  <div style={{ color:"#fff", fontWeight:700, fontSize:12 }}>{s.n}</div>
                  <div style={{ color:"rgba(255,255,255,.35)", fontSize:11, marginTop:1 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Log */}
        <div style={{ marginBottom:8, color:"rgba(255,255,255,.25)", fontSize:9, letterSpacing:2.5, textTransform:"uppercase" }}>Sistem Logu</div>
        <Ticker logs={logs} />
        <div style={{ marginTop:22, textAlign:"center", color:"rgba(255,255,255,.1)", fontSize:9, letterSpacing:1.5 }}>
          JUS DIGITALIS v2.1 © 2025 · ENFLASYONdan KORUNAN SÖZLEŞMELER · TRUSTLESS TRUST
        </div>
      </div>

      {activeBot && (
        <ContractModal
          bot={activeBot} coins={coins}
          onClose={()=>setActiveBot(null)}
          onResult={handleResult}
          addLog={addLog}
        />
      )}
    </>
  );
}
