import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getDatabase, ref, set, get, update, onValue, push, remove,
  onDisconnect, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBreTSe1m0-xlbF4aupnU5isRZCihR25IE",
  authDomain: "formwheel.firebaseapp.com",
  databaseURL: "https://formwheel-default-rtdb.firebaseio.com",
  projectId: "formwheel",
  storageBucket: "formwheel.firebasestorage.app",
  messagingSenderId: "431583088241",
  appId: "1:431583088241:web:74e0e34ea1e3e1170c55d0",
  measurementId: "G-T372YXDF8D"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
let serverOffset=0;const serverNow=()=>Date.now()+serverOffset;
onValue(ref(db,".info/serverTimeOffset"),snap=>serverOffset=Number(snap.val())||0);

const $ = id => document.getElementById(id);
const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]));

// ---- obstacle physics constants (shared by solo & battle) ----
const BASE_FALL_SPEED = 150;   // px / second, at the very start of a round
const SPEED_RAMP = 1.35;       // px/s that fall speed gains per second the round has run
const MAX_FALL_SPEED = 430;    // cap so it never becomes unreadable
const DANGER_GAP = 0.95;       // seconds between danger-obstacle spawns
const HOURGLASS_GAP = 4.0;     // seconds between hourglass spawns (fixed, exact)
const FIRST_DANGER_AT = 1.0;   // first danger obstacle spawns at this many seconds
const FIRST_HOURGLASS_AT = 4.0;// first hourglass spawns at this many seconds
const JUDGE_Y = 470;           // collision line (px from top of arena)
const EXIT_Y = 560;            // obstacle removed from view past this point

// Deterministic pseudo-random in [0,1), a pure function of (seed, index).
// Same seed+index always gives the same value, so every client in a battle
// room computes identical obstacle lanes without needing to sync a growing
// list through the database — and it never "runs out" since it's computed
// on demand for whatever index the current elapsed time needs.
function seededValue(seed, index){
  const x = Math.sin(seed*12.9898 + index*78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Each obstacle falls at whatever speed was in effect the moment it spawned
// (a simple constant per obstacle, no integration needed) — so as the round
// goes on, freshly-spawned obstacles fall progressively faster, giving a
// steady ramp-up in difficulty over time, capped at MAX_FALL_SPEED.
function fallSpeedAt(spawnSec){
  return Math.min(MAX_FALL_SPEED, BASE_FALL_SPEED + SPEED_RAMP*spawnSec);
}

// Computes which obstacles are currently visible given elapsed seconds, and
// fires onHit(type) once per obstacle the moment it crosses the judge line in
// the player's current lane. Danger obstacles and hourglasses run on two
// independent, indefinitely-extending tracks (each spawn time is derived
// directly from its index, not stored in an array), so gameplay never stalls
// no matter how long a round runs, and the hourglass cadence stays exactly
// fixed regardless of how many danger obstacles have spawned.
function stepObstacles(seed, elapsedSec, processed, currentLane, onHit){
  const visible = [];
  for(let i=0; FIRST_DANGER_AT+i*DANGER_GAP<=elapsedSec; i++){
    const spawnSec = FIRST_DANGER_AT+i*DANGER_GAP;
    const y = -35 + fallSpeedAt(spawnSec)*(elapsedSec-spawnSec);
    if(y > EXIT_Y) continue;
    const lane = Math.floor(seededValue(seed*2+1, i)*3);
    visible.push({lane, y, type:"obstacle"});
    const key="d"+i;
    if(y>=JUDGE_Y && !processed.has(key)){
      processed.add(key);
      if(lane===currentLane) onHit("obstacle");
    }
  }
  for(let i=0; FIRST_HOURGLASS_AT+i*HOURGLASS_GAP<=elapsedSec; i++){
    const spawnSec = FIRST_HOURGLASS_AT+i*HOURGLASS_GAP;
    const y = -35 + fallSpeedAt(spawnSec)*(elapsedSec-spawnSec);
    if(y > EXIT_Y) continue;
    const lane = Math.floor(seededValue(seed*2+2, i)*3);
    visible.push({lane, y, type:"hourglass"});
    const key="h"+i;
    if(y>=JUDGE_Y && !processed.has(key)){
      processed.add(key);
      if(lane===currentLane) onHit("hourglass");
    }
  }
  for(let i=0;12+i*12<=elapsedSec;i++){
    const spawnSec=12+i*12,y=-35+fallSpeedAt(spawnSec)*(elapsedSec-spawnSec),lane=Math.floor(seededValue(seed*2+3,i)*3),type=seededValue(seed*2+4,i)<.5?'star':'shield';
    if(y>EXIT_Y)continue;visible.push({lane,y,type});const key='e'+i;if(y>=JUDGE_Y&&!processed.has(key)){processed.add(key);if(lane===currentLane)onHit(type)}
  }
  return visible;
}

let mode = "solo";
let room = "";
let playerId = "";
let isHost = false;
let roomUnsub = null;
let gameUnsub = null;
let leaderboardUnsub = null;

let local = {
  lane:1, time:10, alive:false, startedAt:0, elapsed:0,
  seed:0, processed:null, lastTick:0,points:0,combo:0,charge:0,shield:false
};

let soloTimer = null;let attackReceipts=new Set(),battleFinished=false;

function randomCode(){
  return String(Math.floor(100000 + Math.random()*900000));
}
function randomId(){
  return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2,8);
}

$("soloMode").onclick = () => setMode("solo");
$("battleMode").onclick = () => setMode("battle");

function setMode(m){
  mode=m;
  $("soloMode").classList.toggle("active",m==="solo");
  $("battleMode").classList.toggle("active",m==="battle");
  $("soloSetup").classList.toggle("hidden",m!=="solo");
  $("battleSetup").classList.toggle("hidden",m!=="battle");
}

$("soloStart").onclick = startSolo;
$("createRoom").onclick = createRoom;
$("joinRoom").onclick = joinRoom;
$("leaveRoom").onclick = leaveRoom;
$("startBattle").onclick = hostStartBattle;
$("leftBtn").onclick = () => move(-1);
$("rightBtn").onclick = () => move(1);
$("retryBtn").onclick=()=>{if(mode==='solo')startSolo();else if(isHost&&battleFinished)hostStartBattle();else $("battleStatus").textContent='배틀 종료 후 방장이 다시 시작할 수 있습니다.'};
function applyPickup(type){if(type==='hourglass'){local.combo++;local.charge++;local.time+=5;local.points+=100+Math.min(10,local.combo)*20}else if(type==='star'){local.time+=3;local.points+=50}else if(type==='shield'){local.shield=true;local.points+=50}else{local.combo=0;if(local.shield)local.shield=false;else local.time-=3}}
let attackBusy=false;
$("attackBtn").onclick=async()=>{if(attackBusy||mode!=='battle'||!local.alive||local.charge<3)return;const target=$("attackTarget").value;if(!target||target===playerId)return;attackBusy=true;const id=crypto.randomUUID(),stamp=local.startedAt;local.charge-=3;try{const result=await runTransaction(ref(db,`timeRooms/${room}`),data=>{if(!data||data.meta?.status!=='playing'||data.game?.startedAt!==stamp||!data.players?.[target]?.alive||!data.players?.[playerId]?.alive)return;data.attacks??={};data.attacks[id]={from:playerId,to:target,at:serverNow(),round:stamp};return data});if(!result.committed)local.charge+=3}catch(e){local.charge+=3;window.FormwheelUI?.error(e)}finally{attackBusy=false;updateTimeStat()}};


window.addEventListener("keydown", e=>{
  if(e.target.matches("input,textarea,select"))return;
  if(e.key==="ArrowLeft"){e.preventDefault();move(-1)}
  if(e.key==="ArrowRight"){e.preventDefault();move(1)}
});

onValue(ref(db,".info/connected"),snap=>{$("connectionStatus").textContent=snap.val()===true?"Firebase 연결됨 ✅":"Firebase 연결 대기 · 네트워크를 확인하세요."});

const savedName = localStorage.getItem("formwheel_time_name");
if(savedName){
  $("soloNickname").value = savedName;
}

function showGame(){
  $("gameCard").classList.remove("hidden");
  window.scrollTo({top:$("gameCard").offsetTop-10,behavior:"smooth"});
}
function showHome(){
  $("gameCard").classList.add("hidden");
}
function renderLane(){
  $("laneText").textContent = String(local.lane+1);
  $("myDot").style.left = ((local.lane+0.5)*100/3)+"%";
  document.querySelectorAll(".lane").forEach(l=>{
    l.classList.toggle("active", Number(l.dataset.lane)===local.lane);
  });
}

function resetArena(){
  document.querySelectorAll(".obstacle").forEach(x=>x.remove());
}
function renderObstacles(list){
  resetArena();
  const arena=$("arena");
  for(const obs of list){
    const el=document.createElement("div");
    el.className="obstacle "+(obs.type!=="obstacle"?"good":"bad");
    el.textContent={hourglass:"⏳",obstacle:"💥",star:"⭐",shield:"🛡"}[obs.type];
    el.style.left=((obs.lane+0.5)*100/3)+"%";
    el.style.top=obs.y+"px";
    arena.appendChild(el);
  }
}
function updateTimeStat(){
  $("timeText").textContent=Math.max(0,local.time).toFixed(1);
  $("scoreStatus").textContent=`점수 ${Math.floor(local.elapsed*10)+local.points} · 콤보 ${local.combo} · 충전 ${local.charge} ${local.shield?"· 🛡":""}`;
  $("attackBtn").disabled=mode!=="battle"||!local.alive||local.charge<3;$("attackTarget").hidden=mode!=="battle";
  $("timeStat").classList.toggle("danger", local.time<=3 && local.alive);
}

function spawnConfetti(){
  const emojis=["🎉","✨","⏳","🎊","⭐"];
  for(let i=0;i<22;i++){
    const el=document.createElement("div");
    el.className="confetti";
    el.textContent=emojis[Math.floor(Math.random()*emojis.length)];
    el.style.left=Math.random()*100+"vw";
    el.style.animationDuration=(1.4+Math.random()*1.2)+"s";
    el.style.fontSize=(16+Math.random()*14)+"px";
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),2800);
  }
}

let startingSolo=false;
async function startSolo(){
  if(startingSolo)return;clearInterval(soloTimer);local.alive=false;startingSolo=true;try{if(window.FormwheelUI)await FormwheelUI.countdown(3)}finally{startingSolo=false}
  mode="solo";$("retryBtn").disabled=false;
  showGame();
  resetArena();
  local={
    lane:1,time:10,alive:true,startedAt:performance.now(),elapsed:0,
    seed:Math.floor(Math.random()*1e9),processed:new Set(),lastTick:performance.now(),points:0,combo:0,charge:0,shield:false
  };
  renderLane();
  $("stateText").textContent="RUN";
  $("battleStatus").classList.add("hidden");
  updateTimeStat();
  clearInterval(soloTimer);

  soloTimer=setInterval(()=>{
    if(!local.alive)return;
    const now=performance.now();
    const dt=(now-local.lastTick)/1000;
    local.lastTick=now;
    local.elapsed=(now-local.startedAt)/1000;
    local.time-=dt;

    const visible=stepObstacles(local.seed, local.elapsed, local.processed, local.lane, (type)=>{
      applyPickup(type);
    });
    renderObstacles(visible);
    updateTimeStat();
    if(local.time<=0){
      finishSolo();
    }
  },50);
}
function finishSolo(){
  if(!local.alive)return;
  local.alive=false;
  clearInterval(soloTimer);
  $("stateText").textContent="FINISH";
  $("battleStatus").classList.remove("hidden");
  $("battleStatus").textContent="🏁 기록: "+local.elapsed.toFixed(2)+"초 · "+(Math.floor(local.elapsed*10)+local.points)+"점";
  spawnConfetti();
  saveLeaderboard(local.elapsed);
  window.FormwheelUI?.result("⏱️ Solo 결과",local.elapsed.toFixed(2)+"초 · "+(Math.floor(local.elapsed*10)+local.points)+"점",startSolo);
}
function move(dir){
  if(!local.alive)return;
  local.lane=Math.max(0,Math.min(2,local.lane+dir));
  renderLane();
  if(mode==="battle" && room && playerId){
    update(ref(db,`timeRooms/${room}/players/${playerId}`),{
      lane:local.lane,
      actionAt:serverTimestamp()
    });
  }
}

async function saveLeaderboard(seconds){
  const typed=($("soloNickname").value||"").trim();
  const name=(typed || localStorage.getItem("formwheel_time_name") || prompt("리더보드에 사용할 닉네임을 입력하세요") || "익명").trim().slice(0,12);
  if(!name)return;
  localStorage.setItem("formwheel_time_name",name);

  const root=ref(db,"timeLeaderboard");
  const snap=await get(root);
  const data=snap.exists()?snap.val():{};
  let existingKey=null, existing=null;
  for(const [k,v] of Object.entries(data)){
    if(v && v.name===name){existingKey=k;existing=v;break;}
  }
  if(existing && Number(existing.seconds)>=seconds)return;

  const payload={name,seconds:Number(seconds.toFixed(2)),score:Math.floor(local.elapsed*10)+local.points,updatedAt:serverTimestamp()};
  if(existingKey) await set(ref(db,`timeLeaderboard/${existingKey}`),payload);
  else await set(push(root),payload);
}
function watchLeaderboard(){
  if(leaderboardUnsub) leaderboardUnsub();
  leaderboardUnsub=onValue(ref(db,"timeLeaderboard"),snap=>{
    const vals=Object.values(snap.val()||{}).filter(Boolean)
      .sort((a,b)=>Number(b.seconds)-Number(a.seconds)).slice(0,20);
    if(!vals.length){$("leaderboard").innerHTML='<p class="muted">아직 기록이 없습니다.</p>';return}
    const medal=i=>i===0?"🥇":i===1?"🥈":i===2?"🥉":"";
    $("leaderboard").innerHTML=`<table><thead><tr><th>순위</th><th>닉네임</th><th>기록</th></tr></thead><tbody>`+
      vals.map((v,i)=>`<tr><td class="rank">${medal(i)||(i+1)}</td><td>${escapeHtml(v.name)}</td><td>${Number(v.seconds).toFixed(2)}초</td></tr>`).join("")+
      `</tbody></table>`;
  });
}
watchLeaderboard();

async function createRoom(){
  const name=($("nickname").value||"").trim().slice(0,12);
  if(!name){alert("닉네임을 입력해주세요.");return}
  playerId=randomId();
  room=randomCode();
  isHost=true;
  $("roomCode").value=room;
  $("roomCodeDisplay").textContent=room;

  const roomRef=ref(db,`timeRooms/${room}`);
  await set(roomRef,{
    meta:{status:"waiting",hostId:playerId,createdAt:serverTimestamp()},
    players:{
      [playerId]:{name,lane:1,time:10,alive:true,ready:true,joinedAt:serverTimestamp()}
    },
    game:{status:"waiting"}
  });
  await onDisconnect(ref(db,`timeRooms/${room}/players/${playerId}`)).remove();

  enterLobby();
}
async function joinRoom(){
  const name=($("nickname").value||"").trim().slice(0,12);
  room=($("roomCode").value||"").replace(/\D/g,"").slice(0,6);
  if(!name){alert("닉네임을 입력해주세요.");return}
  if(room.length!==6){alert("6자리 방 코드를 입력해주세요.");return}

  const snap=await get(ref(db,`timeRooms/${room}`));
  if(!snap.exists()){alert("존재하지 않는 방입니다.");return}
  const data=snap.val();
  if(data?.meta?.status!=="waiting"){alert("이미 시작된 방입니다.");return}

  playerId=randomId();
  isHost=false;
  await set(ref(db,`timeRooms/${room}/players/${playerId}`),{
    name,lane:1,time:10,alive:true,ready:true,joinedAt:serverTimestamp()
  });
  await onDisconnect(ref(db,`timeRooms/${room}/players/${playerId}`)).remove();
  $("roomCodeDisplay").textContent=room;
  enterLobby();
}
function enterLobby(){
  $("lobby").classList.remove("hidden");
  $("leaveRoom").classList.remove("hidden");
  $("hostControls").classList.toggle("hidden",!isHost);
  $("createRoom").disabled=true;
  $("joinRoom").disabled=true;
  watchRoom();
}
function watchRoom(){
  if(roomUnsub)roomUnsub();
  roomUnsub=onValue(ref(db,`timeRooms/${room}`),snap=>{
    if(!snap.exists()){
      leaveRoom(false);
      return;
    }
    const data=snap.val();
    isHost=data.meta?.hostId===playerId;renderLobby(data);
    if(data.meta?.status==="playing"){startBattleClient(data);checkBattleEnd().catch(console.error);}
    if(data.meta?.status==="finished") renderBattleFinished(data);
  });
}
function renderLobby(data){
  const players=Object.entries(data.players||{});
  $("players").innerHTML=players.map(([id,p])=>
    `<div class="playerBox"><div class="name">${escapeHtml(p.name)} ${id===data.meta?.hostId?"👑":""}</div><div class="state">${p.ready?"준비 완료":"대기 중"}</div></div>`
  ).join("");
}
async function hostStartBattle(){
  if(!isHost || !room)return;
  const snap=await get(ref(db,`timeRooms/${room}/players`));
  const players=snap.val()||{};
  if(Object.keys(players).length<2){
    if(!confirm("현재 1명입니다. 혼자 테스트로 시작할까요?"))return;
  }

  const startedAt=serverNow()+1200;
  // roundSeed alone is enough — every client derives the same obstacle
  // lanes/timings from it via stepObstacles(), computed on demand, so the
  // round never runs out no matter how long it lasts.
  await update(ref(db,`timeRooms/${room}`),{
    meta:{status:"playing",hostId:playerId,startedAt},
    game:{status:"playing",startedAt,roundSeed:Math.floor(Math.random()*1e9)}
  });
}

function startBattleClient(data){
  battleFinished=false;$("retryBtn").disabled=true;
  if(local.startedAt===data.game?.startedAt)return;
  showGame();
  resetArena();
  const start=Number(data.game.startedAt);
  local={
    lane:1,time:10,alive:true,startedAt:start,elapsed:0,
    seed:Number(data.game.roundSeed)||0,processed:new Set(),lastTick:start,points:0,combo:0,charge:0,shield:false
  };
  $("stateText").textContent="RUN";
  $("battleStatus").classList.remove("hidden");
  $("battleStatus").textContent="🔥 Firebase 실시간 배틀 진행 중";
  renderLane();
  updateTimeStat();

  if(gameUnsub)gameUnsub();
  gameUnsub=onValue(ref(db,`timeRooms/${room}`),snap=>{
    const r=snap.val();
    if(!r)return;
    renderBattlePlayers(r.players||{});
    for(const [id,a] of Object.entries(r.attacks||{})){if(a.to===playerId&&a.round===local.startedAt&&!attackReceipts.has(id)){attackReceipts.add(id);if(local.alive){local.time-=2;local.combo=0;$("battleStatus").textContent='⚡ 상대 공격! 시간 -2초';syncMyState()}}}
    if(r.meta?.status==="playing")checkBattleEnd();
    if(r.meta?.status==="finished") renderBattleFinished(r);
  });

  clearInterval(soloTimer);
  soloTimer=setInterval(()=>battleTick(start),50);
}
function battleTick(startedAt){
  if(!local.alive)return;
  const now=serverNow();
  if(now<Number(startedAt)){
    $("timeText").textContent="10.0";
    return;
  }
  const dt=(now-local.lastTick)/1000;
  local.lastTick=now;
  const elapsed=(now-Number(startedAt))/1000;
  local.elapsed=elapsed;
  local.time-=dt;

  const visible=stepObstacles(local.seed, elapsed, local.processed, local.lane, (type)=>{
    applyPickup(type);
    syncMyState();
  });
  renderObstacles(visible);
  updateTimeStat();
  if(local.time<=0){
    finishBattlePlayer();
  }
}
function syncMyState(){
  if(!room||!playerId)return;
  update(ref(db,`timeRooms/${room}/players/${playerId}`),{
    lane:local.lane,time:Number(Math.max(0,local.time).toFixed(2)),score:Math.floor(local.elapsed*10)+local.points,combo:local.combo,
    alive:local.alive,elapsed:Number(local.elapsed.toFixed(2)),
    updatedAt:serverTimestamp()
  });
}
async function finishBattlePlayer(){
  if(!local.alive)return;
  local.alive=false;
  $("stateText").textContent="OUT";
  await update(ref(db,`timeRooms/${room}/players/${playerId}`),{
    lane:local.lane,time:0,alive:false,elapsed:Number(local.elapsed.toFixed(2)),
    finishedAt:serverTimestamp()
  });
  checkBattleEnd();
}
function renderBattlePlayers(players){
  const select=$("attackTarget"),selected=select.value;select.replaceChildren();for(const [id,p] of Object.entries(players)){if(id===playerId||!p.alive)continue;const option=document.createElement('option');option.value=id;option.textContent=p.name;select.append(option)}if([...select.options].some(o=>o.value===selected))select.value=selected;
  const list=Object.entries(players).sort((a,b)=>Number(b[1].time||0)-Number(a[1].time||0));
  $("battleBoard").classList.remove("hidden");
  $("battleBoard").innerHTML=list.map(([id,p])=>{
    const pct=Math.max(0,Math.min(100,(Number(p.time||0)/10)*100));
    return `<div class="battleRow"><div><b>${escapeHtml(p.name)}${id===playerId?" (나)":""}</b><div class="small">${p.alive?"생존":"탈락"} · ${Number(p.time||0).toFixed(1)}초</div></div><div class="progress"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
}
async function checkBattleEnd(){
 if(!room)return;
 await runTransaction(ref(db,`timeRooms/${room}`),data=>{
  if(!data||data.meta?.status!=="playing")return;
  const players=Object.entries(data.players||{});
  const previousHost=data.meta.hostId;
  if(!data.players?.[data.meta.hostId])data.meta.hostId=players[0]?.[0]||"";
  const alive=players.filter(([,p])=>p.alive);
  if(alive.length>1)return data.meta.hostId!==previousHost?data:undefined;
  const winner=alive[0]?.[1]||players.map(([,p])=>p).sort((a,b)=>Number(b.elapsed||0)-Number(a.elapsed||0))[0];
  data.meta.status="finished";data.meta.winnerName=winner?.name||"참가자 없음";data.meta.finishedAt=serverTimestamp();return data;
 },{applyLocally:false});
}

function renderBattleFinished(data){
  battleFinished=true;local.alive=false;$("retryBtn").disabled=!isHost;$("attackBtn").disabled=true;
  const winner=data.meta?.winnerName||"없음";
  $("stateText").textContent="END";
  $("battleStatus").classList.remove("hidden");
  $("battleStatus").textContent=`🏁 배틀 종료 · 결과: ${escapeHtml(winner)}`;
  clearInterval(soloTimer);
  spawnConfetti();
}
async function leaveRoom(doConfirm=true){
  if(doConfirm && room && playerId){
    try{await remove(ref(db,`timeRooms/${room}/players/${playerId}`))}catch{}
  }
  if(roomUnsub)roomUnsub();
  if(gameUnsub)gameUnsub();
  roomUnsub=gameUnsub=null;
  room="";playerId="";isHost=false;
  $("lobby").classList.add("hidden");
  $("leaveRoom").classList.add("hidden");
  $("hostControls").classList.add("hidden");
  $("createRoom").disabled=false;
  $("joinRoom").disabled=false;
  $("players").innerHTML="";
  showHome();
}
