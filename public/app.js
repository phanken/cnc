const $=id=>document.getElementById(id);

let ws=null;
let id=null;
let count=1;
let speakerId=null;
let pressed=false;
let sending=false;
let speakerOn=true;

let mic=null;
let captureCtx=null;
let sourceNode=null;
let processorNode=null;

let playCtx=null;
let nextPlayTime=0;

const TARGET_RATE=16000;
// ScriptProcessor 512 samples @48kHz ~10.7ms/chunk (thay vì 2048 ~42.7ms)
const PROCESSOR_SIZE=512;
// Buffer phát mục tiêu chỉ ~20ms
const START_BUFFER=0.020;
// Nếu backlog > 220ms thì bỏ đệm cũ để kéo trễ về thấp.
const MAX_AUDIO_BACKLOG=0.220;

async function unlockAudio(){
  if(!playCtx || playCtx.state==="closed"){
    playCtx=new (window.AudioContext||window.webkitAudioContext)({
      latencyHint:"interactive"
    });
  }
  if(playCtx.state==="suspended") await playCtx.resume();

  if(!captureCtx || captureCtx.state==="closed"){
    captureCtx=new (window.AudioContext||window.webkitAudioContext)({
      latencyHint:"interactive"
    });
  }
  if(captureCtx.state==="suspended") await captureCtx.resume();
}

async function getMic(){
  if(mic) return mic;
  mic=await navigator.mediaDevices.getUserMedia({
    audio:{
      echoCancellation:true,
      noiseSuppression:true,
      autoGainControl:true,
      channelCount:1
    },
    video:false
  });
  return mic;
}

function meter(a){
  let sum=0;
  for(let i=0;i<a.length;i++) sum+=a[i]*a[i];
  $("bar").style.width=Math.min(100,Math.sqrt(sum/a.length)*500)+"%";
}

function downsample(input,inRate,outRate){
  if(inRate===outRate) return input;

  const ratio=inRate/outRate;
  const outLen=Math.max(1,Math.floor(input.length/ratio));
  const out=new Float32Array(outLen);

  for(let i=0;i<outLen;i++){
    const a=Math.floor(i*ratio);
    const b=Math.min(input.length,Math.floor((i+1)*ratio));
    let sum=0;
    for(let j=a;j<b;j++) sum+=input[j];
    out[i]=sum/Math.max(1,b-a);
  }
  return out;
}

function floatToPcm16(f){
  const out=new Int16Array(f.length);
  for(let i=0;i<f.length;i++){
    const x=Math.max(-1,Math.min(1,f[i]));
    out[i]=x<0?x*32768:x*32767;
  }
  return out;
}

async function startSend(){
  if(sending) return;

  await unlockAudio();
  const stream=await getMic();

  sourceNode=captureCtx.createMediaStreamSource(stream);
  processorNode=captureCtx.createScriptProcessor(PROCESSOR_SIZE,1,1);

  const zero=captureCtx.createGain();
  zero.gain.value=0;

  sourceNode.connect(processorNode);
  processorNode.connect(zero);
  zero.connect(captureCtx.destination);

  sending=true;

  processorNode.onaudioprocess=e=>{
    if(!sending || !pressed || ws?.readyState!==WebSocket.OPEN) return;

    const input=e.inputBuffer.getChannelData(0);
    meter(input);

    const down=downsample(input,captureCtx.sampleRate,TARGET_RATE);
    const pcm=floatToPcm16(down);

    // Không để hàng đợi WebSocket lớn lên vì sẽ biến thành delay.
    if(ws.bufferedAmount < 64*1024){
      ws.send(pcm.buffer);
    }
  };
}

function stopSend(){
  sending=false;
  $("bar").style.width="0%";

  try{processorNode.onaudioprocess=null}catch{}
  try{processorNode.disconnect()}catch{}
  try{sourceNode.disconnect()}catch{}

  processorNode=null;
  sourceNode=null;
}

async function playPcm(buf){
  if(!speakerOn) return;

  try{
    await unlockAudio();
  }catch{
    $("info").textContent="Trình duyệt đang chặn loa.";
    return;
  }

  const pcm=new Int16Array(buf);
  if(!pcm.length) return;

  const audioBuffer=playCtx.createBuffer(1,pcm.length,TARGET_RATE);
  const ch=audioBuffer.getChannelData(0);

  for(let i=0;i<pcm.length;i++){
    ch[i]=pcm[i]/32768;
  }

  const now=playCtx.currentTime;

  // Nếu mạng làm hàng đợi âm thanh dài lên, bỏ backlog để giữ độ trễ thấp.
  if(nextPlayTime-now > MAX_AUDIO_BACKLOG){
    nextPlayTime=now+START_BUFFER;
  }

  if(nextPlayTime < now+0.005){
    nextPlayTime=now+START_BUFFER;
  }

  const src=playCtx.createBufferSource();
  src.buffer=audioBuffer;
  src.connect(playCtx.destination);
  src.start(nextPlayTime);

  nextPlayTime+=audioBuffer.duration;
}

function updateRoom(){
  $("count").textContent=count;

  if(count>1 && !speakerId){
    $("talk").disabled=false;
    $("status").textContent="Sẵn sàng";
  }else if(count<2){
    $("talk").disabled=true;
    $("status").textContent="Đang chờ máy khác...";
  }
}

$("join").onclick=async()=>{
  const room=$("room").value.trim().toUpperCase();
  if(!room) return alert("Nhập mã phòng");

  try{
    await unlockAudio();
    await getMic();
  }catch{
    return alert("Hãy cho phép dùng micro");
  }

  ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host);
  ws.binaryType="arraybuffer";

  ws.onopen=()=>{
    ws.send(JSON.stringify({type:"join",room}));
  };

  ws.onmessage=async e=>{
    if(e.data instanceof ArrayBuffer){
      playPcm(e.data);
      return;
    }

    const m=JSON.parse(e.data);

    if(m.type==="joined"){
      id=m.id;
      count=m.count;
      speakerId=m.speaker||null;

      $("roomName").textContent=m.room;
      $("joinView").classList.add("hidden");
      $("radioView").classList.remove("hidden");

      updateRoom();
    }

    if(m.type==="count"){
      count=m.count;
      speakerId=m.speaker||null;
      updateRoom();
    }

    if(m.type==="speaker"){
      speakerId=m.id;

      if(!m.id){
        $("status").textContent=count>1?"Sẵn sàng":"Đang chờ máy khác...";
        $("talk").disabled=count<2;
      }else if(m.id===id){
        $("status").textContent="Bạn đang nói";
      }else{
        $("status").textContent="Có người đang nói...";
        $("talk").disabled=true;
      }
    }

    if(m.type==="granted" && pressed){
      await startSend();
      $("talk").classList.add("active");
      $("talkText").textContent="ĐANG NÓI...";
      $("info").textContent="Đang truyền âm thanh độ trễ thấp.";
    }

    if(m.type==="denied"){
      pressed=false;
      stopSend();
    }
  };
};

function begin(e){
  e.preventDefault();

  if(count<2) return;
  if(speakerId && speakerId!==id) return;
  if(!ws || ws.readyState!==WebSocket.OPEN) return;

  pressed=true;
  ws.send(JSON.stringify({type:"talk"}));
}

function end(e){
  if(e) e.preventDefault();

  if(!pressed && speakerId!==id) return;

  pressed=false;
  stopSend();

  $("talk").classList.remove("active");
  $("talkText").textContent="GIỮ ĐỂ NÓI";

  if(ws?.readyState===WebSocket.OPEN){
    ws.send(JSON.stringify({type:"release"}));
  }
}

$("talk").addEventListener("pointerdown",begin);
$("talk").addEventListener("pointerup",end);
$("talk").addEventListener("pointercancel",end);
window.addEventListener("pointerup",()=>pressed&&end());

$("speaker").onclick=async()=>{
  speakerOn=!speakerOn;
  if(speakerOn) await unlockAudio();

  $("speaker").textContent=speakerOn
    ?"🔊 Loa: Bật"
    :"🔇 Loa: Tắt";
};

$("test").onclick=async()=>{
  try{
    await unlockAudio();

    const stream=await getMic();
    const src=captureCtx.createMediaStreamSource(stream);
    const analyser=captureCtx.createAnalyser();
    analyser.fftSize=512;
    src.connect(analyser);

    const data=new Float32Array(analyser.fftSize);
    let peak=0;
    const start=performance.now();

    $("info").textContent="Nói vào micro trong 2 giây...";

    function tick(){
      analyser.getFloatTimeDomainData(data);
      meter(data);

      for(const x of data){
        peak=Math.max(peak,Math.abs(x));
      }

      if(performance.now()-start<2000){
        requestAnimationFrame(tick);
      }else{
        src.disconnect();
        analyser.disconnect();
        $("bar").style.width="0%";
        $("info").textContent=peak>.01
          ?"✅ Micro hoạt động"
          :"❌ Không thấy tín hiệu micro";
      }
    }
    tick();
  }catch{
    $("info").textContent="❌ Không truy cập được micro";
  }
};
