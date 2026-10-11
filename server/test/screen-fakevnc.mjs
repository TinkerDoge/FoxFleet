// Test fixture (from Soran's QA, /workspace/audits/foxfleet-bot-screen): a fake VNC-over-WebSocket server for the screen DOM test. Run: node screen-fakevnc.mjs PORT
// Minimal fake VNC-over-WebSocket server (RFB 3.8, security None, raw encoding, 1440x900 test pattern). usage: node fakevnc.mjs PORT
import http from 'node:http'; import crypto from 'node:crypto';
const W=1440,H=900, port=Number(process.argv[2]||5959);
function wsFrame(buf){const n=buf.length;let h;if(n<126)h=Buffer.from([0x82,n]);else if(n<65536){h=Buffer.alloc(4);h[0]=0x82;h[1]=126;h.writeUInt16BE(n,2)}else{h=Buffer.alloc(10);h[0]=0x82;h[1]=127;h.writeBigUInt64BE(BigInt(n),2)}return Buffer.concat([h,buf])}
function pattern(){const b=Buffer.alloc(W*H*4);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4;const border=x<6||y<6||x>=W-6||y>=H-6;const grid=(x%120<3)||(y%100<3);b[i]=border?255:(grid?255:(x*255/W)|0);b[i+1]=border?255:(grid?255:(y*255/H)|0);b[i+2]=border?0:(grid?255:160);b[i+3]=0}return b}
const px=pattern();
const srv=http.createServer((q,r)=>r.end('fake vnc')).on('upgrade',(req,sock)=>{
  const key=req.headers['sec-websocket-key'];const acc=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  const send=(b)=>sock.write(wsFrame(b)); let stage=0, acc2=Buffer.alloc(0), pend=Buffer.alloc(0);
  send(Buffer.from('RFB 003.008\n'));
  function onMsg(m){ // client payload
    if(stage===0&&m.length>=12){send(Buffer.from([1,1]));stage=1;return}
    if(stage===1){send(Buffer.from([0,0,0,0]));stage=2;return}
    if(stage===2){const name=Buffer.from('fake');const si=Buffer.alloc(24+name.length);si.writeUInt16BE(W,0);si.writeUInt16BE(H,2);si[4]=32;si[5]=24;si[6]=0;si[7]=1;si.writeUInt16BE(255,8);si.writeUInt16BE(255,10);si.writeUInt16BE(255,12);si[14]=16;si[15]=8;si[16]=0;si.writeUInt32BE(name.length,20);name.copy(si,24);send(si);stage=3;
      const t=()=>{const hd=Buffer.alloc(16);hd[0]=0;hd.writeUInt16BE(1,2);hd.writeUInt16BE(0,4);hd.writeUInt16BE(0,6);hd.writeUInt16BE(W,8);hd.writeUInt16BE(H,10);hd.writeInt32BE(0,12);send(Buffer.concat([hd,px]))};
      setTimeout(t,300);const iv=setInterval(()=>{if(sock.destroyed)clearInterval(iv);else t()},2500);}
  }
  sock.on('error',()=>{});
  sock.on('data',(d)=>{acc2=Buffer.concat([acc2,d]);while(acc2.length>=2){let len=acc2[1]&127,o=2;if(len===126){if(acc2.length<4)return;len=acc2.readUInt16BE(2);o=4}else if(len===127){if(acc2.length<10)return;len=Number(acc2.readBigUInt64BE(2));o=10}
    const masked=acc2[1]&128;const need=o+(masked?4:0)+len;if(acc2.length<need)return;const mk=masked?acc2.slice(o,o+4):null;const p=Buffer.from(acc2.slice(o+(masked?4:0),need));if(mk)for(let i=0;i<p.length;i++)p[i]^=mk[i%4];const op=acc2[0]&15;acc2=acc2.slice(need);
    if(op===8){sock.end();return} if(op===2){ if(stage<3) onMsg(p)} }});
});
srv.listen(port,'127.0.0.1',()=>console.log('fakevnc on',port));
