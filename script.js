const $ = id => document.getElementById(id);
let packets = [], running = false, received = [], lost = 0, retrans = 0, startAt = 0, ackCount = 0;

const controls = [
  ['size','sizeOut',v=>v+'文字'], ['speed','speedOut',v=>v+' packet/s'],
  ['loss','lossOut',v=>v+'%'], ['jitter','jitterOut',v=>v+'%']
];
controls.forEach(([a,b,f]) => $(a).addEventListener('input', () => {
  $(b).textContent = f($(a).value); updateOverhead();
}));

function log(s){
  $('log').textContent = '['+new Date().toLocaleTimeString('ja-JP')+'] '+s+'\n'+$('log').textContent;
}
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function checksum(s){
  let x=0; for(const c of s) x=(x+c.charCodeAt(0))%65536;
  return '0x'+x.toString(16).padStart(4,'0').toUpperCase();
}
function esc(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

function make(){
  const t=$('data').value;
  if(!t.trim()){ alert('元データを入力してください'); return; }
  const n=+$('size').value;
  packets=[];
  for(let i=0;i<t.length;i+=n){
    const data=t.slice(i,i+n);
    packets.push({id:packets.length+1,data,ip1:'192.168.1.10',ip2:'192.168.1.20',checksum:checksum(data)});
  }
  $('source').textContent=`元データ（${t.length}文字）：${t}`;
  renderPackets(); updateOverhead();
  $('start').disabled=false;
  $('log').textContent='パケットを作成しました。各パケットにヘッダを付けて送信します。';
  $('arrival').innerHTML=''; $('ordered').innerHTML=''; $('reconstructed').textContent='まだ受信していません。';
  $('total').textContent=packets.length; ['received','lost','retrans','acks','duplicates'].forEach(x=>$(x).textContent='0');
  $('rate').textContent='0%'; $('time').textContent='0.0s';
}

function updateOverhead(){
  const data=$('data').value.length, size=+$('size').value;
  if(!data){ $('packetCount').textContent='0'; $('overhead').textContent='0%'; $('totalBytes').textContent='0'; return; }
  const count=Math.ceil(data/size), headerBytes=20, total=data+count*headerBytes;
  $('packetCount').textContent=count;
  $('overhead').textContent=((count*headerBytes/total)*100).toFixed(1)+'%';
  $('totalBytes').textContent=total+' bytes';
}

function renderPackets(){
  const html=packets.map(p=>`<div class="card" data-id="${p.id}"><div class="cardHead">Packet ${p.id}</div><div class="cardData">${esc(p.data)}</div><div class="cardMeta">Seq=${p.id}<br>${p.ip1} → ${p.ip2}</div></div>`).join('');
  $('packets').innerHTML=html; $('headerPackets').innerHTML=html;
  document.querySelectorAll('.card').forEach(c=>c.addEventListener('click',()=>openHeader(+c.dataset.id)));
}

function openHeader(id){
  const p=packets.find(x=>x.id===id); if(!p)return;
  $('modalBody').innerHTML=`<div class="headerGrid">
    <div class="field"><span>送信元IP</span><b>${p.ip1}</b><small>「どのPCから来たか」</small></div>
    <div class="field"><span>宛先IP</span><b>${p.ip2}</b><small>「どのPCへ届けるか」</small></div>
    <div class="field"><span>シーケンス番号</span><b>${p.id}</b><small>「何番目のデータか」</small></div>
    <div class="field"><span>チェックサム</span><b>${p.checksum}</b><small>データの誤り検出に使う値（教材用）</small></div>
  </div>`;
  $('modalPayload').textContent=p.data;
  $('modal').classList.add('show'); $('modal').setAttribute('aria-hidden','false');
}
$('close').onclick=()=>{$('modal').classList.remove('show');$('modal').setAttribute('aria-hidden','true')};
$('modal').addEventListener('click',e=>{if(e.target===$('modal'))$('close').click()});

function animateData(p,route,isRetrans=false){
  const lane=route==='A'?$('laneA'):$('laneB');
  const d=document.createElement('div'); d.className='dot'+(isRetrans?' retransmit':''); d.textContent='#'+p.id;
  lane.appendChild(d); requestAnimationFrame(()=>d.style.left='calc(100% - 38px)');
  setTimeout(()=>d.remove(),1200);
}
function animateAck(p){
  const lane=p.route==='A'?$('ackLaneA'):$('ackLaneB');
  const d=document.createElement('div'); d.className='ackDot'; d.textContent='ACK '+p.id;
  lane.appendChild(d); requestAnimationFrame(()=>d.style.left='0%');
  setTimeout(()=>d.remove(),900);
}

function chooseRoute(id){ return id%2===0 ? 'A' : 'B'; }
function calcDelay(id){
  const jitter=+$('jitter').value;
  // 交互授業用：ジッターが高いほど経路差を大きくし、順序入れ替わりを起こしやすくする
  const base=260;
  const alternating=(id%2===0?-1:1)*jitter*3.2;
  const random=(Math.random()-.5)*jitter*2.0;
  return Math.max(120,base+alternating+random);
}

async function send(p){
  const isTCP=$('mode').value==='tcp', lossRate=+$('loss').value;
  const route=chooseRoute(p.id), delay=calcDelay(p.id); p.route=route;
  animateData(p,route,false);
  log(`#${p.id}：経路${route}へ送信 → ヘッダ（IP・Seq・Checksum）を付加`);
  await wait(delay);
  const failed=Math.random()*100<lossRate;
  if(failed){
    lost++; $('lost').textContent=lost; mark(p.id,'lost');
    log(`#${p.id}：❌ パケット損失`);
    if(isTCP){
      log(`#${p.id}：⏱ ACKが届かない → タイムアウト → 再送`);
      await wait(450);
      retrans++; $('retrans').textContent=retrans;
      log(`#${p.id}：🔁 Retransmit（再送） → 経路${route}`);
      animateData(p,route,true);
      await wait(delay*.75);
      receivePacket(p,true);
    } else {
      log(`#${p.id}：UDPなので再送しない → このパケットは欠落`);
    }
    return;
  }
  receivePacket(p,false);
}

function receivePacket(p,isRetrans){
  const duplicate=received.some(x=>x.id===p.id);
  if(duplicate){ $('duplicates').textContent=+$('duplicates').textContent+1; log(`#${p.id}：重複到着 → 受信側は同じSeqとして処理`); return; }
  received.push({...p,retransmitted:isRetrans,arrival:Date.now()});
  arrival(p,isRetrans); mark(p.id,'sent');
  if($('mode').value==='tcp'){
    ackCount++; $('acks').textContent=ackCount; animateAck(p);
    log(`#${p.id}：✓ 受信側に到着 → ACK #${p.id} を返送`);
    setTimeout(()=>log(`#${p.id}：✓ 送信側にACK #${p.id} が到着`),500);
  } else log(`#${p.id}：✓ 受信側に到着 → ACKなし（UDP）`);
}

function mark(id,cls){document.querySelectorAll(`[data-id="${id}"]`).forEach(x=>x.classList.add(cls));}
function arrival(p,isRetrans){
  const d=document.createElement('div'); d.className='chip'+(isRetrans?' retransChip':'');
  d.innerHTML=`<b>#${p.id}</b>「${esc(p.data)}」${isRetrans?' <small>再送</small>':''}`;
  d.title='クリックでヘッダ'; d.addEventListener('click',()=>openHeader(p.id)); $('arrival').appendChild(d); updateOrdered();
}
function updateOrdered(){
  const by={}; received.forEach(p=>by[p.id]=p);
  $('ordered').innerHTML=packets.map(p=>by[p.id]?`<div class="chip"><b>#${p.id}</b>「${esc(p.data)}」</div>`:`<div class="chip missing"><b>#${p.id}</b> 未到着</div>`).join('');
  $('reconstructed').textContent=packets.map(p=>by[p.id]?p.data:'□'.repeat(p.data.length)).join('');
}

async function start(){
  if(running||!packets.length)return;
  running=true; $('start').disabled=true; $('make').disabled=true;
  received=[]; lost=0; retrans=0; ackCount=0; startAt=performance.now();
  ['received','lost','retrans','acks','duplicates'].forEach(x=>$(x).textContent='0');
  const interval=1000/(+$('speed').value);
  for(const p of packets){ await wait(interval); send(p); }
  await wait(2600); finish(); running=false; $('make').disabled=false;
}
function finish(){
  updateOrdered();
  const unique=new Set(received.map(p=>p.id)), complete=unique.size>=packets.length;
  const sec=(performance.now()-startAt)/1000;
  $('received').textContent=unique.size; $('rate').textContent=Math.round(unique.size/packets.length*100)+'%'; $('time').textContent=sec.toFixed(1)+'s';
  $('quality').innerHTML=complete
    ? `全パケットがそろいました。${$('mode').value==='tcp'?'TCPでは損失時に再送するため、信頼性は高まりますが通信時間が増えます。':'UDPでは再送しないため、損失があればデータが欠落します。'}<br>到着順はシーケンス番号で並べ替えて再構成しました。`
    : `パケットが不足しています。<br>損失率・ジッター・通信方式を変えて比較してみましょう。`;
}

$('make').onclick=make; $('start').onclick=start; $('reset').onclick=()=>location.reload();
