const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  maxPayload: 128 * 1024
});

const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req,res)=>res.json({ok:true,rooms:rooms.size}));

function send(ws,obj){
  if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room,obj,except=null){
  const data=JSON.stringify(obj);
  for(const ws of room.clients){
    if(ws!==except && ws.readyState===WebSocket.OPEN) ws.send(data);
  }
}
function roomState(room){
  broadcast(room,{type:"count",count:room.clients.size,speaker:room.speaker?.id||null});
}
function cleanup(ws){
  if(!ws.roomCode) return;
  const room=rooms.get(ws.roomCode);
  if(!room) return;

  room.clients.delete(ws);

  if(room.speaker===ws){
    room.speaker=null;
    broadcast(room,{type:"speaker",id:null});
  }

  if(room.clients.size===0){
    rooms.delete(ws.roomCode);
  }else{
    roomState(room);
  }
}

wss.on("connection",ws=>{
  ws.id=Math.random().toString(36).slice(2,10);

  // Giảm trễ do Nagle ở TCP layer.
  try { ws._socket.setNoDelay(true); } catch {}

  ws.on("message",(data,isBinary)=>{
    const room=ws.roomCode ? rooms.get(ws.roomCode) : null;

    if(isBinary){
      if(!room || room.speaker!==ws) return;

      for(const client of room.clients){
        if(client===ws || client.readyState!==WebSocket.OPEN) continue;

        // Nếu máy nhận đã backlog quá nhiều thì bỏ packet cũ thay vì càng lúc càng delay.
        if(client.bufferedAmount < 128 * 1024){
          client.send(data,{binary:true,compress:false});
        }
      }
      return;
    }

    let m;
    try { m=JSON.parse(data.toString()); } catch { return; }

    if(m.type==="join"){
      const code=String(m.room||"")
        .trim().toUpperCase()
        .replace(/[^A-Z0-9_-]/g,"")
        .slice(0,20);

      if(!code) return;

      if(!rooms.has(code)){
        rooms.set(code,{clients:new Set(),speaker:null});
      }

      const r=rooms.get(code);
      ws.roomCode=code;
      r.clients.add(ws);

      send(ws,{
        type:"joined",
        id:ws.id,
        room:code,
        count:r.clients.size,
        speaker:r.speaker?.id||null
      });

      roomState(r);
      return;
    }

    if(!room) return;

    if(m.type==="talk"){
      if(!room.speaker || room.speaker===ws){
        room.speaker=ws;
        broadcast(room,{type:"speaker",id:ws.id});
        send(ws,{type:"granted"});
      }else{
        send(ws,{type:"denied"});
      }
      return;
    }

    if(m.type==="release" && room.speaker===ws){
      room.speaker=null;
      broadcast(room,{type:"speaker",id:null});
    }
  });

  ws.on("close",()=>cleanup(ws));
  ws.on("error",()=>cleanup(ws));
});

server.listen(process.env.PORT||3000,"0.0.0.0",()=>console.log("V5 low latency server started"));
